import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDshApiServer } from "../lib/server.js"
import { createSourcesLoader, matchSource, renderWrapper, sourceAllowsSession } from "../lib/sources.js"

const S1 = "session-aaaa-1111"
const S2 = "session-bbbb-2222"

const sourcesDoc = {
  sources: [
    { name: "intel", token: "intel-token-0001", sessions: [S1], wrapper: "【情报】{name}\n{text}", allow: ["prompt"] },
    { name: "watch", token: "watch-token-0002", sessions: [S2], wrapper: "{text}", allow: ["prompt", "history"] },
    { name: "root", token: "root-token-00003", sessions: ["*"], wrapper: "{text}", allow: ["prompt", "passthrough"] }
  ]
}

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-api-"))
  const path = join(dir, name)
  if (content !== undefined) writeFileSync(path, content)
  return path
}

const recordings = []

function fakeApi() {
  return {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [{ sessionId: S1 }, { sessionId: S2 }, { sessionId: "session-cccc" }] } } }),
      create: async () => ({ result: { ok: true, value: { sessionId: "session-new" } } }),
      prompt: async (call) => {
        recordings.push(call.payload)
        return { result: { ok: true, value: { accepted: true } } }
      },
      history: async () => ({ result: { ok: true, value: { messages: [] } } }),
      cancel: async () => ({ result: { ok: true, value: { ok: true } } })
    },
    events: { mux: async function* () { yield { payload: { sessionId: S1 } } } }
  }
}

const passthroughFetch = async () => Response.json({ type: "server-response", via: "passthrough" })

async function start(t, sourcesPath, auditPath) {
  const server = createDshApiServer({
    api: fakeApi(), fetch: passthroughFetch, token: "legacy-token-9", port: 0, sourcesPath, auditPath
  })
  server.listen(0, "127.0.0.1")
  t.after(() => server.close())
  await once(server, "listening")
  return server
}

async function call(server, path, token, init = {}) {
  const { port } = server.address()
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
  })
  const text = await response.text()
  return { status: response.status, body: text }
}

test("来源表：token 匹配、会话白名单、包装模板", () => {
  const path = tmpFile("sources.json", JSON.stringify(sourcesDoc))
  const load = createSourcesLoader(path)
  const { sources, error } = load()
  assert.equal(error, null)
  assert.equal(sources.length, 3)
  const intel = matchSource(sources, "intel-token-0001")
  assert.equal(intel.name, "intel")
  assert.equal(sourceAllowsSession(intel, S1), true)
  assert.equal(sourceAllowsSession(intel, S2), false)
  assert.equal(renderWrapper(intel.wrapper, { name: "intel", text: "新曲上线" }), "【情报】intel\n新曲上线")
  // 空数组不等于全权
  const empty = { sessions: [] }
  assert.equal(sourceAllowsSession(empty, S1), false)
})

test("来源表：文件缺失走旧模式、写坏则回落不崩", () => {
  const missing = createSourcesLoader("/nonexistent/sources.json")
  assert.deepEqual(missing().sources, [])
  const broken = createSourcesLoader(tmpFile("sources.json", "{ not json"))
  const first = broken()
  assert.equal(first.sources.length, 0)
  assert.match(first.error, /解析失败/)
})

test("未知 token → 401", async (t) => {
  const server = await start(t, tmpFile("sources.json", JSON.stringify(sourcesDoc)))
  const r = await call(server, `/api/sessions/${S1}/prompt`, "nope")
  assert.equal(r.status, 401)
})

test("跨会话 → 403，且不落到 api", async (t) => {
  recordings.length = 0
  const server = await start(t, tmpFile("sources.json", JSON.stringify(sourcesDoc)))
  const r = await call(server, `/api/sessions/${S2}/prompt`, "intel-token-0001", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: [{ type: "text", text: "hi" }] })
  })
  assert.equal(r.status, 403)
  assert.equal(recordings.length, 0)
})

test("授权会话 → 200，且正文被包装", async (t) => {
  recordings.length = 0
  const server = await start(t, tmpFile("sources.json", JSON.stringify(sourcesDoc)))
  const r = await call(server, `/api/sessions/${S1}/prompt`, "intel-token-0001", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: [{ type: "text", text: "新曲上线" }] })
  })
  assert.equal(r.status, 200)
  assert.equal(recordings.length, 1)
  assert.equal(recordings[0].content[0].text, "【情报】intel\n新曲上线")
  assert.equal(recordings[0].mode, "queue")
})

test("入口白名单：intel 不能用 history", async (t) => {
  const server = await start(t, tmpFile("sources.json", JSON.stringify(sourcesDoc)))
  const r = await call(server, `/api/sessions/${S1}/history`, "intel-token-0001")
  assert.equal(r.status, 403)
  const ok = await call(server, `/api/sessions/${S2}/history`, "watch-token-0002")
  assert.equal(ok.status, 200)
})

test("受限 token 不能走 /api 通配转发", async (t) => {
  const server = await start(t, tmpFile("sources.json", JSON.stringify(sourcesDoc)))
  const denied = await call(server, "/api/session.list", "intel-token-0001")
  assert.equal(denied.status, 403)
  const allowed = await call(server, "/api/session.list", "root-token-00003")
  assert.equal(allowed.status, 200)
  assert.match(allowed.body, /passthrough/)
})

test("列会话被过滤到白名单内", async (t) => {
  const doc = { sources: [{ name: "lister", token: "lister-token-01", sessions: [S1], allow: ["list", "prompt"] }] }
  const server = await start(t, tmpFile("sources.json", JSON.stringify(doc)))
  const r = await call(server, "/api/sessions", "lister-token-01")
  assert.equal(r.status, 200)
  const body = JSON.parse(r.body)
  assert.deepEqual(body.items.map((x) => x.sessionId), [S1])
  assert.equal(body.filteredBySource, "lister")
})

test("受限 token 不能新建会话", async (t) => {
  const server = await start(t, tmpFile("sources.json", JSON.stringify(sourcesDoc)))
  const r = await call(server, "/api/sessions", "intel-token-0001", { method: "POST", body: "{}" })
  assert.equal(r.status, 403)
})

test("审计落盘：每条请求一行，带来源名与状态码", async (t) => {
  const auditPath = tmpFile("audit.jsonl")
  const server = await start(t, tmpFile("sources.json", JSON.stringify(sourcesDoc)), auditPath)
  await call(server, `/api/sessions/${S2}/prompt`, "intel-token-0001", { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "x" }] }) })
  await call(server, `/api/sessions/${S1}/prompt`, "intel-token-0001", { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "y" }] }) })
  assert.equal(existsSync(auditPath), true)
  const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].status, 403)
  assert.equal(lines[1].status, 200)
  assert.equal(lines[1].source, "intel")
})

test("没有 sources 文件时退回旧单 token 模式", async (t) => {
  recordings.length = 0
  const server = await start(t, "")
  const ok = await call(server, `/api/sessions/${S1}/prompt`, "legacy-token-9", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: [{ type: "text", text: "raw" }] })
  })
  assert.equal(ok.status, 200)
  // 旧模式不包装
  assert.equal(recordings[0].content[0].text, "raw")
  const denied = await call(server, `/api/sessions/${S1}/prompt`, "wrong", { method: "POST", body: "{}" })
  assert.equal(denied.status, 401)
})
