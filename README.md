# paperclip-plugin-cliproxy-connector

Paperclip plugin that syncs [CLIProxy](https://github.com/router-for-me/CLIProxyAPI) per-account
quota into a local cache and routes `usage_aware` AI-connection pools quota-aware, with
wait/resume. Missing provider data is **unknown, never headroom**.

Built for [TWO-586](https://github.com/TogetherWeOwn/paperclip/issues/586) from the
[TWO-578 spike](https://github.com/TogetherWeOwn/paperclip/issues/578) matrix and the
[TWO-579 router-defaults comparison](https://github.com/TogetherWeOwn/paperclip/issues/579).
Covers every CLIProxy provider in v1 — official and plugin: Claude, Codex/OpenAI, Meta,
Gemini/Antigravity, xAI and others, plus Synthetic, NVIDIA NIM, Cloudflare Workers AI, z.ai,
opencode-go. Paperclip sees protocol families (Messages/Responses/Chat); each account joins a
pool by protocol family, pinned by CLIProxy prefix in pool member `profile.model`.

## How it works

- **Sync job** (`cliproxy-sync`, cron `*/5 * * * *` + on-demand action): reads the CLIProxy
  account list (`auth-files`) and per-provider quota (plugin normalized `QuotaFetchResponse`
  routes) through the §4 safe path, and normalises them into `AiConnectionUsage`-shaped rows in
  the plugin's own state namespace. No core changes, no fork.
- **Router** (`ai.connections.route`, capability `ai.connections.route`): pure function over the
  cache. 10% reserve default (strict `>`, minimum across gating windows); rotation — not
  most-headroom — among above-reserve members; pinned tasks never migrate (pinned wait uses the
  latest limiting reset); pooled wait uses the earliest per-member recovery (each member's
  latest limiting reset, or the 60 s recheck when it has none); unknown/stale telemetry
  rechecks in 60 s; stale telemetry fails open only within a bounded grace window
  (≥2× sync interval freshness, 3× grace), then fails closed. Two ages are tracked:
  cache age (the sync fetch time — sync death fails closed) and per-window observation
  age (idle accounts go unknown/fail-open, never stuck low; passed resets and passed
  cooldowns stop limiting).
- **Per-account UI page + dashboard widget**: served worker-side from the cache; the React bundle
  in `ui/` renders it. The bundle never sees the management key.
- **Operator provisioning script** (`scripts/provision-connections.mjs`): dry-run-first helper
  that builds per-account connection payloads and pool member `profile.model` specs from a
  prefix map.

## Setup (operator only)

Agents must never run the CLIProxy management API or this provisioning flow; every key-bearing
step below is run by the operator.

1. Install the plugin into a stock Paperclip host (`>= 2026.1023.0`) with
   `enableAiConnectionRouters` on, and board-approve the `companies.read`, `secrets.read-ref`
   and `plugin.state.*` capabilities the manifest declares.
2. Create a board Paperclip secret holding the CLIProxy **management** key (loopback only —
   the plugin validates this). Note its `secret_ref`.
3. Configure the company (plugin settings page):
   ```json
   {
     "cliproxyBaseUrl": "http://127.0.0.1:8317",
     "managementKeyHeader": "X-Management-Key",
     "managementSecretRef": { "uid": "<board secret uid>" },
     "prefixMap": { "acct-claude-1": "<connection-id-1>" },
     "pluginQuotaIds": { "acct-claude-1": "claude-quota-plugin-id" },
     "audienceConfirmed": true
   }
   ```
   `managementKeyHeader` has no default on purpose; legacy string-UUID secrets fail closed.
   `audienceConfirmed` acknowledges the page shows upstream account identity (proposal §4.4).
4. Provision connections (dry run first):
   ```
   PAPERCLIP_API_URL=https://paperclip.example.com \
   PAPERCLIP_BOARD_TOKEN_FILE=$HOME/.paperclip/board-token \
   node scripts/provision-connections.mjs --company <companyId> --map prefix-map.json
   ```
   Re-run with `--apply` to create. Pool membership stays a board-UI action.
5. Confirm the sync ran (plugin page shows per-account rows), then point pool members at
   `<prefix>/<model-id-as-listed>` models.

## Config reference

| Key | Default | Notes |
|---|---|---|
| `cliproxyBaseUrl` | — (required) | Loopback only (`localhost`, `127.0.0.1`, `::1`). |
| `managementKeyHeader` | — (required) | Exact header name CLIProxy expects. No default. |
| `managementSecretRef` | — (required) | `secret_ref` object. Never persisted, never leaves the worker. |
| `syncIntervalMinutes` | `5` | The cron runs every 5 min; larger values make runs skip. Range 1–60. |
| `reservePercent` | `10` | Default reserve; per-pool `thresholdPercent` derives `100 − t`. |
| `perPoolReservePercent` | `{}` | Per-pool override, wins over everything. |
| `recheckSeconds` | `60` | Wait before re-probing unknown/stale telemetry. |
| `maxAgeMultiplier` / `graceMultiplier` | `2` / `3` | Freshness = sync interval × 2; grace = freshness × 3. |
| `prefixMap` | `{}` | CLIProxy prefix → Paperclip connection id. Empty warns + drift. |
| `providerWindows` | spike matrix §2 | Per-provider gating-window allow-lists (lowercased substrings). |
| `pluginQuotaIds` | `{}` | CLIProxy plugin id per prefix for quota fetch. |
| `audienceConfirmed` | `false` | Page shows upstream identity; confirm the audience, then set `true`. |

## Endpoint assumptions

The management paths are pinned in code (`/v0/management/auth-files` and
`/v0/management/plugins/<segment>/quota`) — there are deliberately no config knobs for
them, and the key is never sent to `/v1` paths. If your CLIProxy build differs, change the
pinned constants in `src/cliproxy.ts` (and the `ENDPOINTS` block at the top of
`scripts/provision-connections.mjs` for the board REST calls) — everything else follows.
Exact live management JSON is still operator-captured (spike §8 item 8); parsers are
defensive by design: unknown shapes become warnings + quota-blind rows, never headroom.

## Security properties (all tested)

- Management key: resolved per sync run from `secret_ref`, in memory only, never persisted,
  never in UI/agent/log surfaces (`cliproxy.test.ts` + `sync.test.ts` redaction tests prove it).
- Safe path only: loopback base URL, key header attached after origin validation, GET-only
  allow-list, `api-call` excluded and un-admittable, manual redirects with revalidation
  (max 2, same-origin loopback), 15 s timeouts, 2 MB caps, schema-checked JSON.
- Strike budget (host-wide): first 401/403 stops the run and marks the secret bad; sync
  never re-probes while the secret is marked bad. A 2nd auth failure per rolling 30 min
  hard-disables sync until explicit board re-enable (`reenable` route/action, board users
  only — agent/system callers are rejected). The budget lives in instance-scoped plugin
  state keyed by CLIProxy origin, so every company targeting the same CLIProxy shares one
  budget (the CLIProxy lockout bans the whole host). Re-enable keeps the rolling failures
  and refuses to probe while the window is full — the page says "wait until \<time\>".
  Config edits never reset the budget.
- Single-flight + minimum 60 s interval between runs.
- Router never calls CLIProxy inline; identity is verified per row against the operator map.

## Testing

```
npm run check   # typecheck + vitest (123 tests) + build (worker + UI bundle)
```

Test files mirror the sources: `router.test.ts` (reserve, rotation, pinned, stale,
admission signals, identity), `sync.test.ts` (strike budget, drift, single-flight,
best-effort plugin fetch, redaction), `parsers.test.ts` (per-provider quota, window gating),
`cliproxy.test.ts` (allow-list, redirects, caps, redaction), `config.test.ts`,
`ui-data.test.ts`, `plugin.test.ts` (harness: job, data, actions, API routes).
