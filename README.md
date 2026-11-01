# dsh-api

Local HTTP API for DeepSeek Harness (DSH). Other AI agents use it to control
DSH through plain HTTP instead of the GUI.

Milestone one covers session control: list and create sessions, read history,
send prompts, stream replies, and cancel turns. Everything else remains
available through the raw `/api/*` passthrough.

## Install

Install the plugin into a DSH web profile:

```bash
dsh plugin --profile web add link:C:/path/to/dsh-api
```

The package declares `dsh.bundle.patch`, so `dsh plugin` registers it in the
profile's `dsh.profile.bundles` automatically. No manual cordis patch is
needed. Once published, install from the registry with
`dsh plugin --profile web add @kelemiao/dsh-api`.

Settings live in the GUI Settings page under `dsh-api` and apply immediately.

## Settings

| Field   | Type   | Default               | Notes                  |
|---------|--------|-----------------------|------------------------|
| enabled | bool   | true                  | server on/off          |
| port    | int    | 4777                  | 1-65535, loopback only |
| token   | secret | generated on first run | fixed bearer token     |

## Endpoints

| Method | Path                      | Purpose                                        |
|--------|---------------------------|------------------------------------------------|
| GET    | `/health`                 | Public health check.                           |
| GET    | `/api/sessions`           | List sessions: `{ items: SessionSummary[] }`.  |
| POST   | `/api/sessions`           | Create session; body `{ cwd?, workspaceId?, agentPreset? }`. |
| GET    | `/api/sessions/:id/history` | Read history; query `beforeSeq?`, `maxMessages?`. |
| POST   | `/api/sessions/:id/prompt` | Send prompt; body `{ content, mode? }`.        |
| POST   | `/api/sessions/:id/cancel` | Cancel the running turn.                       |
| GET    | `/api/sessions/:id/stream` | SSE stream filtered to this session.           |
| POST   | `/api/*`                  | Raw official ApiProxy JSON RPC passthrough.    |
| GET    | `/api/events.mux`         | Raw official aggregated SSE stream.            |

Convenience routes win over the passthrough; any other request whose path
starts with `/api/` is forwarded verbatim to the official ApiProxy transport.

## Authentication

All routes except `/health` require `Authorization: Bearer <token>`. The
server binds `127.0.0.1` only. Missing or wrong tokens get `401`.

## SSE

```bash
curl -N -H "Authorization: Bearer $DSH_API_TOKEN" \
  http://127.0.0.1:4777/api/sessions/<sessionId>/stream
```

Frames are official MuxFrame objects, filtered by session id. A prompt whose
single text block starts with `/` runs as a slash command, like the GUI.

## Smoke test

With the plugin enabled in a running DSH:

```bash
DSH_API_TOKEN=<token> node scripts/smoke.mjs
```

`DSH_API_URL` defaults to `http://127.0.0.1:4777`.

## Scope

Out of milestone one: ergonomic wrappers for approvals, subagents, goals,
jobs, settings, credentials, and workspace mutation; TLS; remote bind;
multi-user tokens.

## Source table (this fork)

Point `sourcesPath` at a JSON file and every token becomes one **source**: it may only
touch the sessions listed for it, may only use the entrypoints it lists, and its prompt
text is wrapped server-side so the agent can tell where the message came from.

```json
{
  "sources": [
    {
      "name": "intel",
      "token": "intel-token-0001",
      "sessions": ["session-67f34c31-58df-4b16-b864-59ba6b56bd5d"],
      "wrapper": "【情报 #{id}】{name} · {ts}\n{text}",
      "allow": ["prompt"]
    },
    {
      "name": "root",
      "token": "root-token-000003",
      "sessions": ["*"],
      "wrapper": "{text}",
      "allow": ["prompt", "passthrough"]
    }
  ]
}
```

Rules:

| Rule | Behaviour |
|------|-----------|
| unknown token | `401` |
| session not listed | `403`, `api` is never called |
| `sessions: []` | no access at all — only `"*"` means every session |
| `allow` omitted | defaults to `["prompt"]` |
| `allow` restricted | also gates `list` / `create` / `history` / `cancel` / `stream` / `passthrough` |
| `GET /api/sessions` | result is filtered to the source's sessions and tagged `filteredBySource` |
| `/api/*` passthrough | **denied** for restricted tokens unless `passthrough` is listed — otherwise the whitelist is meaningless |
| no `sourcesPath` | legacy single-token mode, unwrapped, full access |

`wrapper` understands `{name}`, `{text}`, `{id}` (random 8 chars per call) and `{ts}`.
The file is re-read on mtime change, so adding a source does not need a restart.

Set `auditPath` to append one JSON line per call (`source`, `method`, `path`, `status`,
`sessionId`, `ms`) — that is how you answer "who pushed this sentence into this session".
