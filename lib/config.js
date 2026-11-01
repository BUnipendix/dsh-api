import z from "@deepseek-ai/schemastery"
import { randomUUID } from "node:crypto"

export const DEFAULT_PORT = 4777
export const SETTINGS_NAMESPACE_RAW = "dsh-api"

export const DshApiSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT),
  token: z.string().min(8).role("secret"),
  // 来源表：不填=旧的单 token 全权模式；填了=按 token 分来源、限会话、套包装
  sourcesPath: z.string().default(""),
  // 审计：每次调用一行 JSON，用来回答「是谁往这个会话塞了话」
  auditPath: z.string().default("")
})

const generatedToken = randomUUID().replaceAll("-", "")

export function resolveSettings(entry = {}) {
  return {
    enabled: entry.enabled ?? true,
    port: entry.port ?? DEFAULT_PORT,
    token: entry.token && entry.token.length >= 8 ? entry.token : generatedToken,
    sourcesPath: entry.sourcesPath ?? "",
    auditPath: entry.auditPath ?? ""
  }
}
