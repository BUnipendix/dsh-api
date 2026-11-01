/**
 * 来源表：一个 token = 一个来源 + 它能碰的会话 + 入口白名单 + 包装模板。
 *
 * 存在两个理由：
 *   1. 不同来源（TG 情报、脚本、别的 agent）拿到的是不同 token，互相看不见对方的会话；
 *   2. 调用方只传原文，包装在服务端拼，agent 一眼能认出「这话是谁递进来的」。
 *
 * 没有配置 sources 文件时退回旧的单 token 全权模式，不改变既有用法。
 */
import { appendFileSync, readFileSync, statSync } from "node:fs"

/** 受限来源默认只能 prompt；其余入口要显式列出来。 */
export const DEFAULT_ALLOW = ["prompt"]

const ALLOWED_ENTRYPOINTS = new Set([
  "prompt", "history", "stream", "cancel", "list", "create", "passthrough"
])

/** 通配会话：明确写成 "*" 才是全权，空数组一律当「没授权」，避免空值被误读成全开。 */
function normalizeSessions(raw) {
  if (!Array.isArray(raw)) return []
  const out = raw.map((x) => String(x).trim()).filter((x) => x !== "")
  return out
}

function normalizeAllow(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_ALLOW]
  const out = raw.map((x) => String(x).trim()).filter((x) => ALLOWED_ENTRYPOINTS.has(x))
  return out.length > 0 ? out : [...DEFAULT_ALLOW]
}

/** 包装模板：只做 {name} {text} {id} {ts} 四个占位符替换，不做表达式求值。 */
export function renderWrapper(template, { name = "", text = "", id = "", ts = "" } = {}) {
  const tpl = typeof template === "string" && template !== "" ? template : "{text}"
  return tpl
    .replaceAll("{name}", String(name))
    .replaceAll("{id}", String(id))
    .replaceAll("{ts}", String(ts))
    .replaceAll("{text}", String(text))
}

/**
 * 读来源表，按 mtime 缓存。文件不存在返回 []（= 走旧模式），语法错误返回 {error}，
 * 调用方据此回落到旧模式并记日志——不能让一个写坏的配置文件把整个 API 打死。
 */
export function createSourcesLoader(path) {
  let mtimeMs = -1
  let cached = []
  let lastError = null

  return function load() {
    if (!path) return { sources: [], error: null }
    let st
    try {
      st = statSync(path)
    } catch {
      // 文件没建：这不是错误，走旧模式
      mtimeMs = -1
      cached = []
      return { sources: [], error: null }
    }
    if (st.mtimeMs === mtimeMs) return { sources: cached, error: lastError }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      mtimeMs = st.mtimeMs
      lastError = `sources.json 解析失败：${String(error?.message ?? error)}`
      return { sources: cached, error: lastError }
    }
    const list = Array.isArray(parsed?.sources) ? parsed.sources : []
    cached = list
      .map((raw) => ({
        name: String(raw?.name ?? "").trim(),
        token: String(raw?.token ?? ""),
        sessions: normalizeSessions(raw?.sessions),
        allow: normalizeAllow(raw?.allow),
        wrapper: typeof raw?.wrapper === "string" ? raw.wrapper : "{text}"
      }))
      .filter((s) => s.token !== "")
    mtimeMs = st.mtimeMs
    lastError = null
    return { sources: cached, error: null }
  }
}

/** token → 来源条目。没命中返回 null。 */
export function matchSource(sources, token) {
  if (!token) return null
  for (const source of sources) {
    if (source.token === token) return source
  }
  return null
}

/** 来源能不能碰这个会话。0 个会话 = 谁都不给。 */
export function sourceAllowsSession(source, sessionId) {
  if (!source) return false
  if (source.sessions.includes("*")) return true
  return source.sessions.includes(String(sessionId))
}

export function sourceAllowsEntry(source, entry) {
  if (!source) return false
  return source.allow.includes(entry)
}

/** 审计：一行一个 JSON，追加写。写失败不影响主流程，只报错到 stderr。 */
export function createAuditor(path) {
  if (!path) return () => {}
  return function audit(record) {
    try {
      appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`)
    } catch (error) {
      console.error("[dsh-api] audit write failed:", error)
    }
  }
}
