/**
 * dsh-api：给外部来源用的最小注入服务。
 *
 * 只做一件事——把一段文本推进一个被授权的会话，并让 agent 知道这是谁递进来的。
 * 不依赖 dsh-host-apiproxy（0.2.1 已移除），也不用 dsh-settings：
 * 配置读 ~/.dsh/dsh-api/config.json，来源表读 sources.json，两个文件都按 mtime 热读。
 */
import { createDshApiServer } from "./server.js"
import { readConfig } from "./config.js"

export const name = "dsh-api"
export const inject = ["sessionController"]

export function apply(ctx, config = {}) {
  let server = null

  const start = () => {
    const settings = readConfig(config)
    if (!settings.enabled) return
    server = createDshApiServer({
      sessionController: ctx.sessionController,
      port: settings.port,
      legacyToken: settings.token,
      sourcesPath: settings.sourcesPath,
      auditPath: settings.auditPath
    })
    server.on("error", (error) => {
      console.error("[dsh-api] server error:", error)
      if (server === server) server = null
    })
    server.listen(settings.port, "127.0.0.1", () => {
      console.error(`[dsh-api] listening on 127.0.0.1:${settings.port}`)
    })
  }

  ctx.effect(() => {
    start()
    return () => { if (server) server.close() }
  }, "dsh-api: local prompt endpoint")
}
