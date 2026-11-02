/**
 * 最小注入服务：POST /prompt 把一段文本推进被授权的会话；GET /health 探活。
 *
 * 只有这条路径，是因为调用方要的全部就是「叫醒某个 Bot 并告诉它这是谁递来的」。
 * 没有 history / cancel / stream，也没有 /api 透传——那面墙越薄，白名单才越有意义。
 */
import { createServer } from "node:http"
import { createAuditor, createSourcesLoader, matchSource, renderWrapper, sourceAllowsSession } from "./sources.js"

const MAX_TEXT = 20000

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = ""
  req.setEncoding("utf8")
  req.on("data", (chunk) => {
    data += chunk
    if (data.length > 2_000_000) reject(new Error("body too large"))
  })
  req.on("end", () => {
    if (data.trim() === "") return resolve({})
    try { resolve(JSON.parse(data)) } catch (error) { reject(error) }
  })
  req.on("error", reject)
})

const bearerOf = (req) => {
  const header = req.headers.authorization ?? ""
  return header.startsWith("Bearer ") ? header.slice(7) : ""
}

/** 把来源的 wrapper 套在正文外面；没有来源（旧模式）就原样返回。 */
export function wrapText(text, source) {
  if (!source) return text
  return renderWrapper(source.wrapper, {
    name: source.name,
    text,
    id: Math.random().toString(16).slice(2, 10),
    // 本地时间：拿到 03:52Z 这种 UTC 值，判断「这条新不新」会算错一次时区
    ts: new Date().toLocaleString("sv-SE", { hour12: false })
  })
}

export function createDshApiServer({
  sessionController, port, legacyToken = "", sourcesPath = "", auditPath = ""
}) {
  const loadSources = createSourcesLoader(sourcesPath)
  const audit = createAuditor(auditPath)

  return createServer(async (req, res) => {
    const startedAt = Date.now()
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    let source = null
    let sessionId = null

    const finish = (status, body) => {
      audit({
        source: source ? source.name : "(legacy)",
        method: req.method,
        path: url.pathname,
        status,
        sessionId,
        ms: Date.now() - startedAt
      })
      json(res, status, body)
      return true
    }

    try {
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, dshApi: true }))
        return
      }

      const { sources, error } = loadSources()
      const restricted = sources.length > 0
      if (error) console.error(`[dsh-api] ${error}`)
      if (restricted) {
        source = matchSource(sources, bearerOf(req))
        if (!source) return finish(401, { ok: false, error: { code: "unauthorized", message: "unknown token" } })
      } else if (bearerOf(req) !== legacyToken) {
        return finish(401, { ok: false, error: { code: "unauthorized", message: "missing or invalid bearer token" } })
      }

      if (url.pathname !== "/prompt") {
        return finish(404, { ok: false, error: { code: "not-found", message: `unknown route ${url.pathname}` } })
      }
      if (req.method !== "POST") {
        return finish(405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } })
      }

      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return finish(400, { ok: false, error: { code: "bad-body", message: String(error?.message ?? error) } })
      }

      const text = typeof body.text === "string" ? body.text : ""
      if (text.trim() === "") {
        return finish(400, { ok: false, error: { code: "empty-text", message: "text 不能为空" } })
      }
      if (text.length > MAX_TEXT) {
        return finish(400, { ok: false, error: { code: "text-too-long", message: `text ${text.length} 字符，上限 ${MAX_TEXT}` } })
      }

      // 会话：来源只授权了一个就直接用它；多个则必须显式指定且仍在白名单内
      const allowed = source ? source.sessions : []
      const requested = body.sessionId ? String(body.sessionId) : ""
      if (source) {
        if (allowed.length === 1 && requested === "") {
          sessionId = allowed[0]
        } else if (allowed.includes("*")) {
          sessionId = requested
        } else if (requested !== "" && sourceAllowsSession(source, requested)) {
          sessionId = requested
        } else {
          return finish(403, {
            ok: false,
            error: { code: "forbidden", message: "这个 token 不能写这个会话", sessionId: requested || "(未指定)" }
          })
        }
      } else {
        sessionId = requested
      }
      if (!sessionId || !/^session-[0-9a-zA-Z-]{8,}$/.test(sessionId)) {
        return finish(400, { ok: false, error: { code: "bad-session", message: `sessionId 不合法：${sessionId || "(空)"}` } })
      }

      const mode = String(body.mode ?? "queue") === "steer" ? "steer" : "queue"
      const content = [{ type: "text", text: wrapText(text, source) }]
      try {
        await sessionController.prompt(
          { sessionId, requestId: `dsh-api-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, mode, content },
          new AbortController().signal
        )
      } catch (error) {
        return finish(502, { ok: false, error: { code: "prompt-failed", message: String(error?.message ?? error) } })
      }
      return finish(200, { ok: true, accepted: true, sessionId, mode, source: source ? source.name : "(legacy)", chars: text.length })
    } catch (error) {
      return finish(500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } })
    }
  })
}
