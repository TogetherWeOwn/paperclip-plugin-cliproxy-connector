# paperclip-plugin-cliproxy-connector

Paperclip plugin that discovers [CLIProxy](https://github.com/router-for-me/CLIProxyAPI)
accounts per provider into a local cache and routes `usage_aware` AI-connection pools
quota-aware, with wait/resume. Missing provider data is **unknown, never headroom**.

One config row per CLIProxy provider family — accounts added, removed, or disabled in
CLIProxy appear in or vanish from the sync cache with zero config change (auto-discovery).
Built for [TWO-679](https://github.com/TogetherWeOwn/paperclip/issues/679), superseding the
v1 per-account design.

## How it works

- **Sync job** (`cliproxy-sync`, cron `*/5 * * * *` + on-demand action): reads the CLIProxy
  account list (`auth-files`) grouped by provider, plus per-provider quota (plugin
  normalized `QuotaFetchResponse` routes), through the §4 safe path, and normalises them
  into the plugin's own state namespace — one provider aggregate per `providers[]` row,
  with discovered accounts kept as informational detail underneath. Each sync also fetches
  the served model list (`GET /v1/models`, with the separate client API key) and derives
  every provider's proven model ids from it together with the auth-file list. No core
  changes, no fork.
  Config-key credentials (`claude-api-key`, `codex-api-key`, openai-compatibility, vertex)
  are invisible to `auth-files` — see `completeInventory` below.
- **Router** (`ai.connections.route`): pure function over the cache. Each pool member
  resolves to a provider via its binding `connectionId` → `providers[]` row; the requested
  model comes from the candidate `runtimeConfig.model` (falling back to the member
  `profile.model`) where CLIProxy reports per-model quota. `allowed`/`unknown` members are
  selected (fail open); `exhausted` members are skipped with `retryAt`. A pool with nothing
  selectable returns `exhausted` with the **earliest** `retryAt` so core `ai_connection_wait`
  wakes at the first possible recovery; pinned tasks never migrate (same rule, pinned member
  alone). Rotation — not most-headroom — orders selectable members.
- **Per-provider UI page + dashboard widget**: served worker-side from the cache; the React
  bundle in `ui/` renders it. The bundle never sees the management key.
- **Wait/resume is per provider and gated**: a provider returns `exhausted` only when every
  enabled account is positively out **and** `completeInventory: true` confirms there are no
  hidden config-key credentials. Otherwise it routes `allowed`/`unknown` — never a wait.
  The page shows "wait/resume off: inventory not confirmed complete" until the operator
  confirms.

## Setup (operator only)

The plugin works on a **stock** CLIProxy with no aliases or prefixes: it derives each
provider's model list at every sync from the live served-model list plus the auth-file
list. A connection's model list is its provider's stock ids — bare for Claude,
Codex/OpenAI, Antigravity and Meta; `devin/…` for Devin (built into CLIProxy); the fixed
plugin namespaces `synthetic/…`, `nvidia/…`, `cloudflare/…`, `zai/…`, `opencode-go/…`;
`opencode-zen-free` (openai-compat) is bare unless its entry sets the stock `prefix`
field. `openrouter` is recognised as a parser key (display-only, quota-blind — its
upstream exposes nothing usable), but like any other provider string it still needs one
`providers[]` row and no plugin update. Bare-id overlap is
resolved against each credential's live served set
(`GET /v0/management/auth-files/models?name=<file>`, one fetch per enabled auth file;
a file that answers — even with an empty set — supersedes that credential's
`model_quotas` keys and `owned_by` fallback, so stale quota state cannot fabricate
an overlap; older builds without the endpoint fall back to the `model_quotas`
heuristic with a warning). If one served id maps to more than one provider (the stock example is
`claude-sonnet-4-6`, served by both claude and antigravity), the page flags the overlap
and the id counts as no provider's proven model; setting that openai-compat entry's
`prefix` field is an optional operator-side fix.

Agents must never call the CLIProxy management API; every key-bearing step below is run by
the operator. You read redacted output only.

1. Install the plugin into a stock Paperclip host (`>= 2026.1023.0`) with
   `enableAiConnectionRouters` on, and board-approve the `companies.read`, `secrets.read-ref`
   and `plugin.state.*` capabilities the manifest declares.
2. Create a board Paperclip secret holding the CLIProxy **management** key (loopback only —
   the plugin validates this). Note its `secret_ref`.
3. Create a second board secret holding a CLIProxy **client** (non-management) API key and
   note its `secret_ref`. The plugin uses it only for `GET /v1/models`; the management key
   is never sent to `/v1` paths. (Without it the sync still runs, but model → provider
   derivation and overlap detection stay off.)
3b. Optional, for the provider-spend section: create a **dedicated** board secret holding
   an OpenRouter API key — never reuse a CLIProxy key for a public host — and set
   `openRouterSecretRef` to its `secret_ref`. Without it the spend section reads
   "not configured", never an error. Deploy step (not code): the host `http.outbound`
   egress policy must allow `openrouter.ai`; verify on staging before relying on the read.
4. Create one Paperclip connection per CLIProxy provider family (stock model ids, one
   single-member pool per provider), and configure the company (plugin settings page):
   ```json
   {
     "cliproxyBaseUrl": "http://127.0.0.1:8317",
     "managementKeyHeader": "X-Management-Key",
     "managementSecretRef": { "type": "secret_ref", "secretId": "<board secret id>", "version": "latest" },
     "clientApiKeySecretRef": { "type": "secret_ref", "secretId": "<board client-key secret id>", "version": "latest" },
     "openRouterSecretRef": { "type": "secret_ref", "secretId": "<board openrouter secret id>", "version": "latest" },
     "apiKeyUsageEnabled": true,
     "providers": [{ "provider": "claude", "connectionId": "<connection-id>", "completeInventory": true }],
     "audienceConfirmed": true
   }
   ```
   `apiKeyUsageEnabled` defaults to `false`: the request-count read is opt-in (see the
   Usage & Quota section below).
   `managementKeyHeader` has no default on purpose; legacy string-UUID secrets fail closed.
   Multiple gateway connections can share one provider row using
   `connectionIds: ["<primary-connection-id>", "<alias-connection-id>"]` (for example,
   different wire protocols over the same Codex account inventory). The legacy
   `connectionId` remains supported; when both fields are supplied their union is
   used. A connection cannot appear under two providers: ambiguous mappings fail
   configuration validation, rather than selecting whichever row appears first.
   Aliases share one aggregate and never duplicate the account inventory.
   `completeInventory: true` means you confirm this provider has no hidden config-key
   credentials (default `false`: the provider can only be `allowed`/`unknown`, never
   `exhausted`). `audienceConfirmed` acknowledges the page shows upstream account quota
   state (proposal §4.4).
5. Add optional per-provider plugin quota routes (`pluginQuotaIds: { "claude": "<plugin id>" }`)
   for the five quota plugins (Synthetic, NIM, Cloudflare, z.ai, opencode-go); without one,
   the provider routes on passive signals (or unknown). The connector also discovers
   plugin ids from the `auth-files` list itself: entries carrying `quota_plugin_id`
   (unless `supports_quota: false`) supply the fetch id, so a new quota plugin needs no
   config change — an explicit `pluginQuotaIds` entry always wins over discovery.
   Same-provider accounts advertising different plugins each fetch against their own
   route (the first-wins provider id is only the fallback for rows that advertise
   nothing; conflicts warn visibly). Each fetch sends the credential's `auth_index`
   from the `auth-files` list (`?auth_index=…`, required since CLIProxy v8.0.49), so
   every account attaches its own file's quota; failed fetches are best-effort and
   never spend strikes.
6. Confirm the sync ran (plugin page shows one card per provider with its proven models),
   then run traffic — an all-cooling provider shows `exhausted` with the earliest reset as
   `retryAt`, and core wait/resume fires automatically.

## Host contract (read honestly)

- `retryAt` is advisory: core owns the actual wait and clamps it to its own bounds. The
  router returns member selection plus `skipped` notes only.
- The router never sees, forwards, or constrains the task's native execution input — the
  result carries exactly `{ kind, memberId | retryAt, skipped }` (asserted in tests).
- The `subscription-pool` CLIProxy plugin is retired: "pool" here always means Paperclip's
  native AI-connection pools behind `ai.connections.route`.

## Pages: provider state and Usage & Quota

The plugin ships two pages over the same sync cache:

- The **provider** page: one card per `providers[]` row with the aggregate verdict,
  connection, inventory confirmation, proven models, drift and the informational
  per-account detail. Findings suppressed by `ignoredProviders` /
  `ignoredAuthFileRefs` render in a separate accepted section, never as drift.
- The **activity feed** stays quiet by design: every plugin row uses a stable key
  (`cliproxy_connector.drift_detected` / `.drift_cleared` /
  `.drift_still_present` / `sync_failed` / `sync_recovered` / `.setup_error` /
  `.strike_budget_reenabled`) with the human sentence
  in `metadata.summary` plus structured fields. Drift logs only on state changes
  (new key, cleared key, at most one reminder per 24 h per finding); repeated
  identical sync failures log once with the same daily reminder bound. Expect
  near-zero rows per day in steady state.
- The **Usage & Quota** page (`cliproxy-usage`): per-provider verdict, headroom
  (`<n> of <m> enabled accounts with headroom`), earliest known reset with countdown
  (informational — shown for allowed providers too, unlike the exhaustion-only
  retry time), freshness and quota-blind badges with their reason (disabled rows
  never count toward the badge); plus a filterable (provider, status, blind-only)
  and sortable (remaining %, reset — unknowns last) per-account table showing the
  masked account label (`acct-<13 shown>…`, full key never rendered), plan, priority,
  status, cooldown countdown, per-window bars and the display-only `metrics`. Codex
  accounts that report credits show the credit state (available, unlimited, none left),
  balance and observation time; provider rows with `creditsCountAsHeadroom` say so and
  count the accounts routing on credits.
  `summary[]` text is scrubbed like status notes (emails and credential-like tokens
  redacted) before it reaches the page. Both pages are
  read-only over already synced state; the connector never calls the destructive
  `/v0/management/usage-queue` endpoint (asserted in tests).

  The Usage & Quota page adds four read-model sections over the same cache
  (every section shows its own fetch timestamp; a failed fetch keeps the
  last-known snapshot with a soft note instead of blanking):

  - **Provider spend (OpenRouter)**: `total_credits` / `total_usage` from one
    worker-side `GET https://openrouter.ai/api/v1/credits` per sync, stored as
    four fields only (`provider, totalCredits, totalUsage, fetchedAt`). Without
    `openRouterSecretRef` the section reads "not configured", never an error.
  - **Per-lane usage**: request counts from one `GET /v0/management/api-key-usage`
    per sync (opt-in via `apiKeyUsageEnabled`, off by default; paused for
    30 minutes after a 401/403), aggregated by
    provider in the worker — the composite `base_url|api_key` keys are discarded
    before any state write, so lanes carry provider words and counts only.
    Labelled "requests": there is no per-lane token split from any lawful
    read-only source, and OAuth lanes are invisible to the endpoint, so the page
    says both outright. The quota section timestamp is the latest per-window
    quota observation (`observedAt`, else the row fetch), never the sync
    finish time — a passive window observed hours ago keeps its own age even
    when its cache row was refreshed minutes ago.
  - **Lane map**: the static agent-lane → provider/model table derived from the
    cost-integration plan §1.3 on 2026-11-01, flagged verbatim
    "Config-derived mapping (derived 2026-11-01). Not ledger data." Re-deriving
    the table (and its date) is the only way it changes.
  - **Native cost views**: literal link-outs to `/costs` and `/budgets/overview`
    (write-path policy and budgets stay out of this connector by design).

## Config reference

| Key | Default | Notes |
|---|---|---|
| `cliproxyBaseUrl` | — (required) | Loopback only (`localhost`, `127.0.0.1`, `::1`). |
| `managementKeyHeader` | — (required) | Exact header name CLIProxy expects. No default. |
| `managementSecretRef` | — (required) | `secret_ref` object (`{ "type": "secret_ref", "secretId": "…", "version": "latest" }`). Never persisted, never leaves the worker. |
| `clientApiKeySecretRef` | — (warns when missing) | `secret_ref` object (same shape) for the client API key (`GET /v1/models`). Same never-persisted rule. Missing → derivation + overlap detection off. |
| `openRouterSecretRef` | — (page shows "not configured") | Dedicated `secret_ref` object for the OpenRouter key (spend read only). Never a CLIProxy key; resolved per run, never persisted. |
| `apiKeyUsageEnabled` | `false` | Opt-in request-count read (`GET /v0/management/api-key-usage`, aggregated by provider in the worker). Non-boolean fails closed. |
| `syncIntervalMinutes` | `5` | Freshness baseline only, range 1–60. The cron always runs every 5 min, with a fixed 1-minute minimum between syncs; this setting does not change polling frequency. |
| `reservePercent` | `10` | Default reserve within `[0, 50)`; `0` holds nothing back. A native integer `thresholdPercent` from 1 through 100 derives `100 − t`, including zero reserve at 100. Invalid or absent thresholds use the company default. |
| `perPoolReservePercent` | `{}` | Per-pool reserve within `[0, 50)`, including `0`; wins over the native threshold and company default. |
| `recheckSeconds` | `60` | Wait before re-probing unknown/stale telemetry. |
| `maxAgeMultiplier` / `graceMultiplier` | `2` / `3` | Freshness = sync interval × 2; grace = freshness × 3. |
| `providers` | `[]` | One `{ provider, connectionId, completeInventory }` row per CLIProxy provider family. The provider word is the raw auth-file string (e.g. `cloudflare-workers-ai`); any string is accepted, duplicates error, and a row that matches no accounts drift-warns as having zero enabled accounts. Empty warns. Optional `creditsCountAsHeadroom: true` (default off) lets a fresh positive Codex credits reading (`x-codex-credits-has-credits: true` with a positive or absent `x-codex-credits-balance`, or `x-codex-credits-unlimited: true`) count as headroom while quota windows are exhausted, for providers where the owner allows credit spend. `has-credits: false` or a non-positive balance blocks again; a 429 cooldown, `retry-after` or an unavailable account still gates; a stale reading is `unknown` (fail open). Only `codex` reports credits; other providers warn. |
| `providerWindows` | spike matrix §2 | Per-provider gating-window allow-lists (lowercased substrings). Includes Devin `daily`/`weekly` alongside `5h`. |
| `pluginQuotaIds` | `{}` | CLIProxy plugin id per provider for quota fetch. Wins over `quota_plugin_id` discovery from the `auth-files` list. Fetched per auth file with its `auth_index` (v8.0.49+); entries without one keep one provider-level fetch. |
| `apiCallEnabled` | `{}` (on for `antigravity`/`devin`/`meta`, off otherwise) | Per-provider kill switch for the pinned live `api-call` rounds (`{"antigravity": false}` disables all credential-bearing provider-API calls for that family). Upstream 401/403 already backs an account off for 1 hour; this switch is the manual off-ramp. |
| `metaQuota` | `{ enabled: true }` | Meta live-quota toggle for the download + literal-header key call. Either this or `apiCallEnabled.meta: false` disables all Meta downloads and key calls for the run; Meta accounts then stay on passive signals. |
| `audienceConfirmed` | `false` | Page shows upstream quota state; confirm the audience, then set `true`. |
| `ignoredProviders` | `[]` | Provider words (lowercased, e.g. `openrouter`) whose `unconfigured-provider` drift is explicitly accepted: no finding, no activity row; shown on the page as accepted. |
| `ignoredAuthFileRefs` | `[]` | Accepted `auth file <hash8>` refs (bare hash or full page ref, e.g. `auth file c246e171`) whose `untrusted-auth-file` drift is explicitly accepted. Same accepted-not-alerted rule; typos fail validation loudly. |

## Endpoint assumptions

The management paths are pinned in code (`/v0/management/auth-files`,
`/v0/management/auth-files/models?name=<file>` and
`/v0/management/plugins/<segment>/quota` with exactly one `auth_index` query value,
or no query on older builds) — there are deliberately no config knobs for
them, and the management key is never sent to `/v1` paths. The served-model list has its
own pinned path (`/v1/models`, `MODELS_PATH`) fetched with the separate client API key
(Bearer auth) under the same guarded-fetch rules (loopback, manual redirects, timeouts,
caps, no key leaks); neither key can travel to the other's paths. Antigravity and
Devin publish no passive quota signals, so pinned `POST /v0/management/api-call`
calls per credential per sync read the same live quota the Management Center panel
shows: frozen request templates (exact upstream method, URL, headers and body
copied from the panel source, `apiCallTemplate()` in `src/cliproxy.ts`) whose only
variables are the credential `auth_index` — and, for the Antigravity quota templates,
the account's project id — callers cannot supply their own URL, headers
or body. Upstream `$TOKEN$` placeholders are substituted server-side by CLIProxy; the
plugin never handles credential material — except for Meta, below, where the
panel's own read is the only thing that authenticates. The panel authorizes its
Muse-key quota call with the downloaded `dca_token` (the backend never substitutes
`$TOKEN$` for `dca:` tokens), so Meta rides a dedicated download + literal-header
key call instead of a frozen template: per Meta account the sync `GET`s the
account's auth file (`/v0/management/auth-files/download?name=<file>`), extracts
only its `dca_token` (must match `dca:`, no whitespace), and `POST`s
`https://api.meta.ai/muse-code/key` through `/v0/management/api-call` with the
frozen panel shape (`Accept` / `Content-Type` / `x-api-version: 1.0.0` headers,
`'{}'` body) plus a literal `Authorization: Bearer <dca_token>` header. The token
lives in memory for that one call only: the downloaded body is dropped the moment
the token is out, the token is cleared the moment the call resolves, and neither
is ever logged, persisted, attached to activity/metrics/errors/plugin state, or
shown in UI payloads. The key answer's `subs_usage.window` / `subs_usage.weekly`
(`used_percent`, `resets_at`) become the `meta:window` / `meta:weekly` rows with
the plan name from `subs_tier_name` (falling back to `subs_usage.tier`); a 2xx
without `subs_usage` is unknown, never zero. The key answer's `api_key` is
dropped by the client before caching or parsing: it is never stored, logged, or
displayed. Meta polls at most every 45 minutes
per account (the panel only reads this endpoint on user refresh) with the last 2xx
answer cached between polls; the Usage & quota page's resync action forces a
manual refresh (bypasses the throttle, never the auth backoff). Between polls the
page keeps showing the last-known values with their observation time, but the
router only treats a window as headroom while its observation is fresh (inside
`maxAgeMs`): older cached windows route as unknown, never as headroom or
exhaustion. An upstream
401/403 parks the account for an hour like every other family. Antigravity
reads two calls: the `loadCodeAssist` subscription (plan evidence) plus the winning
`retrieveUserQuotaSummary` quota URL (panel try order, remembered per account) with
the entry's project id in the `{"project": …}` body. An upstream 401/403 backs the
account off for one hour (one warning, no per-sync retry); other upstream errors warn
per file and stay unknown; operator resync is the verification. Transport 401/403 spends the strike budget
like every management GET; any other provider-side error travels inside the returned
envelope and only warns per file (fail open). Live windows are labelled "via provider
API" on the Usage & quota page. If your CLIProxy build
differs, change the pinned constants in `src/cliproxy.ts` — everything else follows.

Two usage-page reads ride the same sync cadence (at most one fetch each per run,
both fail soft with last-known kept):

- `GET https://openrouter.ai/api/v1/credits` (worker-side `ctx.http.fetch`, fixed
  endpoint constant — never config-supplied, so no config edit can steer the
  `Authorization` header). `{"data": {"total_credits", "total_usage"}}` projects to
  four stored fields; anything else is a body error, never spend data. The host
  `http.outbound` egress policy must allow `openrouter.ai` (verify on staging).
- `GET /v0/management/api-key-usage` (pinned allow-list entry, no query string;
  the v8 `/observability/usage/api-keys` route shares the handler, but the v0 path
  stays the only admitted one). The payload's `base_url|api_key` composite keys are
  iterated for their counter values only and never copied past the parse boundary;
  a 401/403 fails closed with one warning, spends no strikes (the management key
  already proved good against `auth-files` this run), and pauses further probes
  for 30 minutes (persisted rejection time; the page keeps showing the pause
  note while probes are off).
The quota-fetch wire shape is the lowercase CLIProxyAPI `sdk/pluginapi`
`QuotaFetchResponse`: `groups[]` → `buckets[]`, with per-bucket `window`,
`remainingFraction`, `resetTime` and a payload-level `summary[]` surfaced as a
display-only `metrics` array per row (the router ignores it). PascalCase aliases are
still tolerated. The always-present empty `quota: { signals: {} }` shell some
providers send is quiet (no "no quota signals" warning); a provider also sending no
`observed_at` still notes that. Devin reports `daily/weekly_quota_remaining_percent`
(with `%`, e.g. `"72%"`) plus `*_reset_at` instead of buckets, parsed into
`daily`/`weekly` windows. Parsers are defensive by design: unknown shapes become
warnings + quota-blind rows, never headroom. The redacted `auth-files` fixture in
tests mirrors the public CLIProxyAPI source shapes.

## Security properties (all tested)

- Management key and client API key: each resolved per sync run from its own `secret_ref`,
  in memory only, never persisted, never in UI/agent/log surfaces (redaction tests prove
  it). Client-key 401/403s never spend the management strike budget.
- Safe path only: loopback base URL, key header attached after origin validation, pinned
  GET allow-list (`api-call` excluded from it and un-admittable through it) plus the
  pinned `api-call` POST templates (exact upstream requests, credential
  `auth_index` — and Antigravity project id — the only variables), manual redirects with revalidation
  (max 2, same-origin loopback), 15 s timeouts, 2 MB caps, schema-checked JSON. The worker
  fetches through its own guarded loopback transport (Node fetch, never the host client —
  the host SSRF guard refuses loopback); the transport re-checks loopback-only, canonical
  origin (`localhost` is rewritten to `127.0.0.1` so no resolver is involved), pinned
  GET and `api-call` POST methods only, and no auto-redirects per request.
- Strike budget (host-wide): first 401/403 stops the run and marks the secret bad; sync
  never re-probes while the secret is marked bad. A 2nd auth failure per rolling 30 min
  hard-disables sync until explicit board re-enable (`reenable` route/action, board users
  only — agent/system callers are rejected). The budget lives in instance-scoped plugin
  state keyed by `loopback:<effective port>`, so every company targeting the same CLIProxy
  shares one budget whatever the loopback spelling (the CLIProxy lockout bans the whole
  host). Re-enable keeps the rolling failures and refuses to probe while the window is
  full — the page says "wait until \<time\>". Config edits never reset the budget.
- Read-model secrets: the OpenRouter key lives behind its own dedicated `secret_ref`
  (never a reused CLIProxy key), resolves per run, travels only as the
  `Authorization` header to the fixed `openrouter.ai` constant (no config-supplied
  URL — no SSRF-by-config), and never reaches persisted state, logs, or error text
  (asserted in tests; the stored note is scrubbed with the live value split out
  first as defense-in-depth).
- Request counts are provider-aggregated in the worker: the `base_url|api_key`
  composite keys are dropped at the parse boundary and structurally cannot reach
  state, UI payloads, logs, or tests (key-absence asserted on the serialized output).
  No `lastError` text is stored unscrubbed.
- Single-flight + minimum 60 s interval between runs.
- Router never calls CLIProxy inline; provider trust comes from the operator `providers[]`
  rows, verified per candidate binding at route time.

## Testing

```
npm run check   # typecheck + vitest + build (worker + UI bundle)
```

Test files mirror the sources: `aggregate.test.ts` (truth table: allowed/unknown/exhausted,
all-cooling earliest reset, mixed, stale, completeInventory gating, per-model incl.
namespaced/bare equivalence), `router.test.ts` (1- and 2-member pools, pinned, earliest
retryAt, missing-connection notes, host-contract shape), `sync.test.ts` (strike budget +
`loopback:<port>` migration, drift incl. `model-overlap`, single-flight, best-effort plugin
fetch, best-effort `/v1/models` fetch that never spends strikes, redaction),
`parsers.test.ts` (header-map signals, model quotas, window gating, lowercase wire-shape
fixtures incl. the 60%-remaining regression test, bucket-less warnings, `summary[]` →
`metrics`, Devin `daily`/`weekly` percents, empty-shell quiet, per-parser blind reasons,
`openrouter` display-only key, `quota_plugin_id` discovery, redacted auth-files fixture,
Devin quota grouped by auth-file provider, spend/counts integration incl. T1 key-absence,
T3 auth-failure fail-closed without strikes, and T5 email scrubbing),
`openrouter.test.ts` (fixed-endpoint credits fetch, shape validation, rotate-secret errors),
`request-counts.test.ts` (composite-key aggregation with key-absence asserted),
`models.test.ts` (served-list parsing,
namespace-first attribution, Devin `owned_by: anthropic` case, colliding bare-id overlap),
`cliproxy.test.ts` (management + client allow-lists, redirects, caps, redaction),
`loopback-fetch.test.ts` (worker-local loopback transport: off-loopback/off-origin/other-method
refused, no auto-redirects, composition with the client),
`config.test.ts` (incl. the optional client-key `secret_ref` and the ignore lists),
`ui-data.test.ts`
(incl. the usage-page data: verdicts, headroom, resets, freshness, blind badges with
reasons, masked labels, metrics passthrough, legacy rows without `quotaBlindReason`,
accepted-findings surfacing),
`plugin.test.ts` (harness: job, data, actions, API routes, stable re-enable key).
