import assert from "node:assert/strict"
import test from "node:test"
import { apply, name, inject } from "../lib/index.js"
import { readConfig } from "../lib/config.js"

test("插件只注入 sessionController，不再依赖 apiProxy", () => {
  assert.equal(name, "dsh-api")
  assert.deepEqual(inject, ["sessionController"])
  assert.equal(typeof apply, "function")
})

test("配置默认值：4777、sources/audit 落在 ~/.dsh/dsh-api", () => {
  const cfg = readConfig({})
  assert.equal(cfg.port, 4777)
  assert.equal(cfg.enabled, true)
  assert.match(cfg.sourcesPath, /\.dsh\/dsh-api\/sources\.json$/)
  assert.match(cfg.auditPath, /\.dsh\/dsh-api\/audit\.jsonl$/)
})
