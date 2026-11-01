import z from "@deepseek-ai/schemastery"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_PORT = 4777
export const SETTINGS_NAMESPACE_RAW = "dsh-api"

export const DshApiSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT),
  token: z.string().min(8).role("secret"),
  // 来源表：留空=旧的单 token 全权模式；填了=按 token 分来源、限会话、套包装。
  // 空值会落到 ~/.dsh/dsh-api/sources.json，开箱即用，不必先进设置页。
  sourcesPath: z.string().default(""),
  // 审计：每次调用一行 JSON，用来回答「是谁往这个会话塞了话」
  auditPath: z.string().default("")
})

const generatedToken = randomUUID().replaceAll("-", "")

const DEFAULT_DIR = join(homedir(), ".dsh", "dsh-api")

/** 相对/空值 → 默认目录下的固定文件；支持 ~ 开头。 */
function expandHome(value, filename) {
  const raw = String(value ?? "").trim()
  if (raw === "") return join(DEFAULT_DIR, filename)
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2))
  return raw
}

export function resolveSettings(entry = {}) {
  return {
    enabled: entry.enabled ?? true,
    port: entry.port ?? DEFAULT_PORT,
    token: entry.token && entry.token.length >= 8 ? entry.token : generatedToken,
    sourcesPath: expandHome(entry.sourcesPath ?? "", "sources.json"),
    auditPath: expandHome(entry.auditPath ?? "", "audit.jsonl")
  }
}
