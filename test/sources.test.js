import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDshApiServer } from "../lib/server.js"
import { createSourcesLoader, matchSource, renderWrapper, sourceAllowsSession } from "../lib/sources.js"

const S1 = "session-aaaa-1111"
const S2 = "session-bbbb-2222"

const doc = {
  sources: [
    { name: "intel", token: "intel-token-0001", sessions: [S1], wrapper: "【情报 #{id}】{name}\n{text}", allow: ["prompt"] },
    { name: "multi", token: "multi-token-0002", sessions: [S1, S2], wrapper: "{text}", allow: ["prompt"] },
    { name: "root", token: "root-token-00003", sessions: ["*"], wrapper: "{text}", allow: ["prompt"] }
  ]
}

const tmpFile = (name, content) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-api-"))
  const path = join(dir, name)
  if (content !== undefined) writeFileSync(path, content)
  return path
}

const calls = []
const fakeController = {
  prompt: async (request) => { calls.push(request); return { accepted: true } }
}

async function start(t, { sourcesPath = "", auditPath = "", token = "legacy-token-9" } = {}) {
  const server = createDshApiServer({
    sessionController: fakeController, port: 0, legacyToken: token, sourcesPath, auditPath
  })
  server.listen(0, "127.0.0.1")
  t.after(() => server.close())
  await once(server, "listening")
  return server
}

async function post(server, body, token, path = "/prompt") {
  const { port } = server.address()
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

test("来源表：白名单、包装模板、空数组不等于全权", () => {
  const path = tmpFile("sources.json", JSON.stringify(doc))
  const { sources, error } = createSourcesLoader(path)()
  assert.equal(error, null)
  const intel = matchSource(sources, "intel-token-0001")
  assert.equal(intel.name, "intel")
  assert.equal(sourceAllowsSession(intel, S1), true)
  assert.equal(sourceAllowsSession(intel, S2), false)
  assert.equal(renderWrapper(intel.wrapper, { name: "intel", text: "新曲上线", id: "abcd1234" }), "【情报 #abcd1234】intel\n新曲上线")
  assert.equal(sourceAllowsSession({ sessions: [] }, S1), false)
})

test("来源表写坏不崩，退回旧模式", () => {
  const broken = createSourcesLoader(tmpFile("sources.json", "{ not json"))()
  assert.equal(broken.sources.length, 0)
  assert.match(broken.error, /解析失败/)
})

test("health 公开，未知 token 401", async (t) => {
  const server = await start(t, { sourcesPath: tmpFile("sources.json", JSON.stringify(doc)) })
  const h = await fetch(`http://127.0.0.1:${server.address().port}/health`)
  assert.equal(h.status, 200)
  const r = await post(server, { text: "x" }, "nope")
  assert.equal(r.status, 401)
})

test("单会话来源：不用指定 sessionId，正文被包装", async (t) => {
  calls.length = 0
  const server = await start(t, { sourcesPath: tmpFile("sources.json", JSON.stringify(doc)) })
  const r = await post(server, { text: "7.2 预下载开放" }, "intel-token-0001")
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, S1)
  assert.match(calls[0].content[0].text, /^【情报 #[0-9a-f]{8}】intel\n7\.2 预下载开放$/)
  assert.equal(calls[0].mode, "queue")
})

test("多会话来源：指定不在白名单的会话 → 403，且不落到 prompt", async (t) => {
  calls.length = 0
  const server = await start(t, { sourcesPath: tmpFile("sources.json", JSON.stringify(doc)) })
  const r = await post(server, { text: "x", sessionId: "session-cccc-3333" }, "multi-token-0002")
  assert.equal(r.status, 403)
  assert.equal(calls.length, 0)
  const ok = await post(server, { text: "y", sessionId: S2 }, "multi-token-0002")
  assert.equal(ok.status, 200)
  assert.equal(calls[0].sessionId, S2)
})

test("star 来源可写任意会话，但 sessionId 必须合法", async (t) => {
  calls.length = 0
  const server = await start(t, { sourcesPath: tmpFile("sources.json", JSON.stringify(doc)) })
  const bad = await post(server, { text: "x", sessionId: "not-a-session" }, "root-token-00003")
  assert.equal(bad.status, 400)
  const ok = await post(server, { text: "z", sessionId: "session-dddd-4444" }, "root-token-00003")
  assert.equal(ok.status, 200)
})

test("空正文 400，超长 400", async (t) => {
  const server = await start(t, { sourcesPath: tmpFile("sources.json", JSON.stringify(doc)) })
  assert.equal((await post(server, { text: "  " }, "intel-token-0001")).status, 400)
  assert.equal((await post(server, { text: "x".repeat(20001) }, "intel-token-0001")).status, 400)
})

test("审计：成功与拒绝各落一行，带来源名", async (t) => {
  const auditPath = tmpFile("audit.jsonl")
  const server = await start(t, { sourcesPath: tmpFile("sources.json", JSON.stringify(doc)), auditPath })
  await post(server, { text: "a", sessionId: "session-cccc-3333" }, "multi-token-0002")
  await post(server, { text: "b" }, "intel-token-0001")
  const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].status, 403)
  assert.equal(lines[1].status, 200)
  assert.equal(lines[1].source, "intel")
})

test("没有 sources 文件时退回单 token 模式，且不包装", async (t) => {
  calls.length = 0
  const server = await start(t, { token: "legacy-token-9" })
  const ok = await post(server, { text: "raw", sessionId: S1 }, "legacy-token-9")
  assert.equal(ok.status, 200)
  assert.equal(calls[0].content[0].text, "raw")
  const deny = await post(server, { text: "raw", sessionId: S1 }, "wrong")
  assert.equal(deny.status, 401)
})
