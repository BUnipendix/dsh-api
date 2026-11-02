/**
 * 配置：优先读 ~/.dsh/dsh-api/config.json，读不到就用默认值。
 * 用文件而不是设置页，是为了不依赖 @deepseek-ai/dsh-settings——
 * 这个插件只需要跑起来、听 4777、认 sources.json。
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_PORT = 4777
export const DEFAULT_DIR = join(homedir(), ".dsh", "dsh-api")

const expandHome = (value, fallback) => {
  const raw = String(value ?? "").trim()
  if (raw === "") return fallback
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2))
  return raw
}

export function readConfig(overrides = {}) {
  const file = join(DEFAULT_DIR, "config.json")
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      console.error(`[dsh-api] config.json 解析失败，用默认值：${String(error?.message ?? error)}`)
    }
  }
  const merged = { ...fromFile, ...overrides }
  return {
    enabled: merged.enabled ?? true,
    port: Number(merged.port ?? DEFAULT_PORT),
    token: String(merged.token ?? ""),
    sourcesPath: expandHome(merged.sourcesPath, join(DEFAULT_DIR, "sources.json")),
    auditPath: expandHome(merged.auditPath, join(DEFAULT_DIR, "audit.jsonl"))
  }
}
