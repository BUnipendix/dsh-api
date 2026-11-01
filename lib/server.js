import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy"
import { nodeToRequest, writeFetchResponse } from "./http-adapter.js"
import {
  createAuditor, createSourcesLoader, matchSource, renderWrapper,
  sourceAllowsEntry, sourceAllowsSession
} from "./sources.js"

const BASE = "http://127.0.0.1"

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => { data += chunk })
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")) } catch (e) { reject(e) } })
    req.on("error", reject)
  })
}

function bearerOf(req) {
  const header = req.headers.authorization ?? ""
  return header.startsWith("Bearer ") ? header.slice(7) : ""
}

function sendRpc(res, response) {
  if (!response || !response.result) {
    return json(res, 200, { ok: false, error: { code: "internal", message: "missing rpc result" } })
  }
  if (!response.result.ok) {
    return json(res, 200, { ok: false, error: response.result.error })
  }
  if (response.result.value === undefined) {
    return json(res, 200, { ok: false, error: { code: "internal", message: "missing rpc result" } })
  }
  return json(res, 200, response.result.value)
}

/**
 * 只在受限来源上包装：调用方递进来的是原文，agent 看到的是带头的那句。
 * 图片等非文本 part 原样保留，只替换第一个 text part。
 */
export function wrapPromptContent(content, source) {
  if (!source) return content
  const parts = Array.isArray(content)
    ? content.slice()
    : (typeof content === "string" ? [{ type: "text", text: content }] : [])
  const index = parts.findIndex((part) => part && part.type === "text")
  const raw = index >= 0 ? String(parts[index].text ?? "") : ""
  const wrapped = renderWrapper(source.wrapper, {
    name: source.name,
    text: raw,
    id: randomUUID().slice(0, 8),
    ts: new Date().toISOString()
  })
  if (index >= 0) {
    parts[index] = { ...parts[index], text: wrapped }
  } else {
    parts.unshift({ type: "text", text: wrapped })
  }
  return parts
}

/** 列会话时把不属于该来源的条目剔掉，避免泄露别人的 session id。 */
export function filterSessionList(value, source) {
  if (!source || !value || !Array.isArray(value.items)) return value
  if (source.sessions.includes("*")) return value
  const items = value.items.filter((item) => sourceAllowsSession(source, item?.sessionId ?? item?.id))
  return { ...value, items, filteredBySource: source.name }
}

export function createDshApiServer({
  api, fetch, token, port, sourcesPath = "", auditPath = ""
}) {
  const loadSources = createSourcesLoader(sourcesPath)
  const audit = createAuditor(auditPath)

  return createServer(async (req, res) => {
    const url = new URL(req.url, BASE)
    const startedAt = Date.now()
    let source = null
    let status = 500
    let sessionId = null

    /** 统一出口：记一行审计再返回。 */
    const reply = (code, body) => {
      status = code
      audit({
        source: source ? source.name : "(legacy)",
        method: req.method,
        path: url.pathname,
        status: code,
        sessionId,
        ms: Date.now() - startedAt
      })
      json(res, code, body)
      return true
    }
    /** 成功路径也要留痕，否则审计表只有失败记录。 */
    const finish = (response) => {
      status = 200
      audit({
        source: source ? source.name : "(legacy)",
        method: req.method,
        path: url.pathname,
        status,
        sessionId,
        ms: Date.now() - startedAt
      })
      return sendRpc(res, response)
    }

    const deny = (message, entry) => reply(403, {
      ok: false,
      error: { code: "forbidden", message, entry }
    })

    try {
      if (url.pathname === "/health") {
        status = 200
        json(res, 200, { ok: true, dshApi: true })
        return
      }

      const { sources, error } = loadSources()
      const restricted = sources.length > 0
      if (restricted) {
        if (error) console.error(`[dsh-api] ${error}——按旧模式（单 token）鉴权`)
        source = matchSource(sources, bearerOf(req))
        if (!source) {
          return reply(401, { ok: false, error: { code: "unauthorized", message: "unknown token" } })
        }
      } else if (bearerOf(req) !== token) {
        return reply(401, { ok: false, error: { code: "unauthorized", message: "missing or invalid bearer token" } })
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(history|prompt|cancel|stream)$/)
      if (sessionMatch) sessionId = sessionMatch[1]

      /** 会话级闸门：来源必须被允许该入口、且被允许这个会话。 */
      const guard = (entry) => {
        if (!restricted) return false
        if (!sourceAllowsEntry(source, entry)) return deny(`this token cannot use ${entry}`, entry)
        if (sessionId && !sourceAllowsSession(source, sessionId)) return deny(`this token cannot touch session ${sessionId}`, entry)
        return false
      }

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        if (restricted && !sourceAllowsEntry(source, "list")) {
          return deny("this token cannot list sessions", "list")
        }
        const response = await api.sessions.list({ rpcId: RpcId(randomUUID()), payload: {} })
        if (response?.result?.ok && response.result.value) {
          response.result = {
            ...response.result,
            value: filterSessionList(response.result.value, source)
          }
        }
        return finish(response)
      }

      if (url.pathname === "/api/sessions" && req.method === "POST") {
        if (restricted && !sourceAllowsEntry(source, "create")) {
          return deny("this token cannot create sessions", "create")
        }
        const body = await readJson(req)
        const response = await api.sessions.create({ rpcId: RpcId(randomUUID()), payload: body })
        return finish(response)
      }

      if (sessionMatch && req.method === "GET" && sessionMatch[2] === "history") {
        if (guard("history")) return
        const response = await api.sessions.history({ rpcId: RpcId(randomUUID()), payload: { ...Object.fromEntries(url.searchParams), sessionId: sessionMatch[1] } })
        return finish(response)
      }

      if (sessionMatch && req.method === "POST" && sessionMatch[2] === "prompt") {
        if (guard("prompt")) return
        const body = await readJson(req)
        const response = await api.sessions.prompt({
          rpcId: RpcId(randomUUID()),
          payload: {
            sessionId: sessionMatch[1],
            mode: body.mode ?? "queue",
            content: wrapPromptContent(body.content, restricted ? source : null)
          }
        })
        return finish(response)
      }

      if (sessionMatch && req.method === "POST" && sessionMatch[2] === "cancel") {
        if (guard("cancel")) return
        const response = await api.sessions.cancel({ rpcId: RpcId(randomUUID()), payload: { sessionId: sessionMatch[1] } })
        return finish(response)
      }

      if (sessionMatch && req.method === "GET" && sessionMatch[2] === "stream") {
        if (guard("stream")) return
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const controller = new AbortController()
        req.on("close", () => controller.abort())
        try {
          for await (const frame of api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, controller.signal)) {
            if (frame.payload && frame.payload.sessionId === sessionMatch[1]) {
              res.write(`data: ${JSON.stringify(frame.payload)}\n\n`)
            }
          }
        } catch (error) {
          res.write(`data: ${JSON.stringify({ type: "stream/error", error: { code: "internal", message: String(error) } })}\n\n`)
        }
        res.end()
        status = 200
        audit({ source: source ? source.name : "(legacy)", method: req.method, path: url.pathname, status, sessionId, ms: Date.now() - startedAt })
        return
      }

      if (url.pathname.startsWith("/api/") || url.pathname === "/api/events.mux") {
        // 通配转发是白名单的漏洞：受限 token 一旦能用它，就能绕开会话限制，
        // 所以必须显式 allow 才放行。
        if (restricted && !sourceAllowsEntry(source, "passthrough")) {
          return deny("this token cannot use the raw /api passthrough", "passthrough")
        }
        status = 200
        audit({ source: source ? source.name : "(legacy)", method: req.method, path: url.pathname, status, sessionId, ms: Date.now() - startedAt })
        await writeFetchResponse(res, await fetch(nodeToRequest(req, BASE)))
        return
      }

      return reply(404, { ok: false, error: { code: "not-found", message: `unknown route ${url.pathname}` } })
    } catch (error) {
      if (status === 500) {
        status = 500
        audit({ source: source ? source.name : "(legacy)", method: req.method, path: url.pathname, status, sessionId, ms: Date.now() - startedAt, error: String(error) })
        json(res, 500, { ok: false, error: { code: "internal", message: String(error) } })
        return
      }
      throw error
    }
  })
}
