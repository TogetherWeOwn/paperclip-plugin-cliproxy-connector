# Disposable stock-host qualification

## Current state: preflight only, not qualified

This draft lane measures supported stock-host startup, exact local-path candidate
installation, disable/enable, real worker data/action RPCs and artifact identity.
It also runs synthetic telemetry through the installed worker and host persistence:
opt-in omitted/false/true, positive/unlimited/zero/absent/stale/undated credits,
healthy windows with stale credits, cooldown/retry-after/spend-control/unavailable,
expired reset/cooldown, account/provider/company isolation and deterministic hardened
metadata refresh. Actual Actions results, not the presence of this code, establish
which assertions passed.

A successful `stock-host` preflight job **does not qualify the candidate**. Native
router eligibility (including model isolation and selectable unknown), actual browser
assertions/screenshots/traces, time-driven expiry transitions and specialist acceptance
remain required. UI data assertions are not browser assertions. Do not use this lane
as installation authority.

## Identity

- Explicitly selected replacement: `1fd7aaa1848c47a56ea0d7154aab16c5f82a548f`
  (PR #24 squash, version `0.3.0`), independently checked out and built with its
  unchanged lockfile and SDK `2026.1023.0`. Reviewed source head
  `41ece7dd83d778822c247c045f78a411fb0199a0` is provenance, not an interchangeable
  build target. Earlier `c129014d765b400d8e547ff469499cd3c34429ff` remains failed;
  its negative browser evidence does not qualify or fail this replacement.
- Stock host source: `d69631b01b9c658f80bf8bed389863dce82643e1`, the source baseline
  associated with the stock `2026.1106.0` host.
- Stock Linux AMD64 image manifest:
  `ghcr.io/paperclipai/paperclip@sha256:12ae7579165cbf11d8db71ef69cf01ff48660383e78541b6b2eba38939fa30c9`.
  Resolved from release tag `2026.1106.0`; its OCI revision matches the host source
  and its OCI version is `2026.1106.0`. The lane verifies that release label and
  the actual health version, while recording server-package and build versions
  separately. It never overrides the host version or claims byte equality with
  the separate npm artifact.
  The first preflight used a different same-source image that reported
  `2026.1005.0+845.git.d69631b01` and failed installation with HTTP 400. The stock
  loader rejects versions below the candidate's minimum `2026.1023.0`; source
  identity alone is therefore insufficient. That failed run is retained, not
  relabeled as release qualification.
- `identity.json` records workflow checkout SHA separately from event SHA (a PR event
  can name a synthetic merge), candidate tree/package/lock hashes, SDK version,
  built worker/UI hashes, run/attempt/job and image manifest/config identity.
- Actions creates the selected version's npm tarball with pack hooks disabled,
  retains it in the evidence archive and records SHA256, npm SHA512 integrity and
  byte size. Each packaged `dist` file must hash identically to the independent
  build and installed-path files. This binds retained package bytes to the tested
  local-path installation; it does not claim that the tarball install path itself
  was tested or that reviewed-head artifacts are equivalent.
- `preflight.json` records installed package path and its artifact hashes, the actual
  stock runtime identity and successful/failed checks. Hashing a UI bundle is not
  browser-load proof. Registry health is not worker RPC proof; the data bridge is
  called separately after enable.

The source digest, image digest, runtime/package identity and candidate artifact
are separate facts. An unavailable artifact or failed assertion is a failure, not
permission to substitute main, a different host, an SDK bump or a core patch.

## Resource and network boundary

The only runtime allocation is one GitHub-hosted `ubuntu-24.04` job with a 25-minute
ceiling, containing the stock host and a bounded browser sidecar. The sidecar joins
only the stock host's network-none namespace, runs as UID 1000 with all capabilities
dropped and no-new-privileges, and has separate CPU/memory/PID/shared-memory bounds.
It receives only its read-only driver/dependencies and writable job-local evidence;
no candidate, production mount, Docker socket or credentials. Chromium's default
Playwright sandbox setting is retained; this is an isolated synthetic browser, not
a browser exposed to untrusted public sites. Both containers are removed explicitly
and share the same native hosted-VM cancellation backstop.
The stock container has no network interface other than loopback (`--network none`),
no published ports, no Docker socket, no production mount, no forwarded job token
and no external database. Embedded PostgreSQL and instance state live in its writable
container layer. Candidate and driver mounts are read-only; the only writable host
mount is the job-local evidence directory. A documentation-address negative control
checks that non-loopback egress cannot succeed. No real CLIProxy management call,
provider request or inference occurs. `installed.mjs` starts a loopback fixture in
that same namespace, authenticates with a fixed non-credential synthetic value, and
serves only allow-listed telemetry GETs. It refuses credential downloads, `api-call`
forwarding, inference and unexpected destinations/methods. Reports retain paths and
counts, not authorization headers. Synthetic host secret references exercise the
stock secret-resolution path; no real credential is created or accessed.

Independent scenarios use separate disposable companies rather than bypassing the
worker's 60-second same-company resync minimum. The deterministic cache-refresh case
uses the same company and waits only until that actual minimum-sync deadline. It
asserts a safe model name is cached before replacing the fixture with rejected
metadata, then asserts the old/rejected names are absent after refresh. Worker
restart compares persisted provider/account values while excluding derived countdown
strings, and verifies no fixture read occurred. Separate timed controls persist an
active unavailable/retry bound, an exhausted window with a future reset, and positive
credits near the unchanged default freshness boundary. They assert the pre-boundary
verdict, wait for the actual telemetry deadline, and reread the same persisted rows
without a telemetry request or clock injection. Each must become unknown, never
measured headroom, then recover only after a real minimum-interval-respecting sync
with fresh positive credits. `installed-matrix.json` retains before/after/recovered
values and boundaries. These are installed aggregate transitions, not native router
or browser execution; only Actions results establish whether they passed.
The unavailable fixture uses the canonical `unavailable: true` lifecycle flag;
a display `status` string alone does not exercise that contract.

## Browser extension (requires its own Actions result)

The browser sidecar pins the Linux AMD64 manifest resolved from the official
Playwright `v1.56.1-noble` image:
`mcr.microsoft.com/playwright@sha256:42f02d323c310069b4d54c94bd91a608966a486c3492c48ae0b1cea747ec5ca2`.
`browser-image.json`, container inspection and actual Chromium version retain that
identity independently of the stock host and candidate. The separate browser lock
contains only `playwright-core@1.56.1` (registry publication 2025-10-17), integrity
`sha512-hutraynyn31F+Bifme+Ps9Vq59hKuUCz7H1kDOcBs+2oGguKkWTU50bBWrtz34OUWmIwpBTWDxaRPXrIXkgvmQ==`.
Neither its manifest nor the root browser package declares lifecycle hooks or
transitive dependencies. Actions verifies npm 11.19.0's project-local three-day age
and script-refusal settings, checks native lock resolution is unchanged, then runs
`npm ci`. No hook exception, browser download hook or candidate dependency change
is made. Clean install/execution acceptance remains pending Actions. The immutable
browser image, like the stock image, has no native npm release-age control; this is
an explicit Security supply-chain residual, not a claim that age proves safety.

`browser/observe.mjs` loads the actual company-prefixed stock plugin page, not a
custom render harness or substituted SDK bridge. It records candidate UI response
SHA256 and requires equality with the independently built artifact. HTTP requests
are restricted to the stock loopback origin: the tested navigation path, native
API GETs, assets/plugin modules/favicon, the exact stock `/fonts/InterVariable.woff2`
asset, and plugin data POSTs only. Other font paths remain denied. Mutating actions,
configuration POSTs, other loopback ports and external origins are denied. Same-host
native API websocket connections are allowed; others are rejected. There is no
network mocking, clock injection, inference endpoint or global-fetch substitution.
Network failures/HTTP errors/console errors/page errors fail the observation and
are retained with screenshots/traces and request paths.

Each installed scenario must agree with the rendered verdict, sync freshness,
opt-in/headroom count, credits/balance/observed-at and account checked-at. A safe
metadata snapshot precedes deterministic rejected-name refresh. Timed controls
reuse the same open page across the real boundary and fresh-telemetry recovery;
they do not reload to simulate automatic UI transitions. The bounded 70-second
agreement deadline covers native 30-second UI ticks/minute refresh throttling.
Screenshots, per-case traces and `browser.json` preserve success/failure details.
Agreement deadlines record the expected values and last rendered card, then continue
remaining controls in the same bounded job. Failed transitions retain their existing
page through recovery, without reload or a forced refresh. Attempts and successful
observations are counted separately; all 28 must succeed, load the exact candidate,
and leave no failures before `/finish` can pass. Collecting later evidence never
changes a failed assertion into a successful qualification.

The run at workflow head `15d064fa3d01899cf100a3327b1a4ce29e80d33c` passed all
18 static scenarios, safe-name refresh and the pre-expiry browser control, but failed
credit-freshness expiry. At `2026-11-08T01:47:55.000Z` the installed worker returned
`unknown` with zero headroom without a telemetry read; the persistent page still
showed `allowed` and one credit-headroom account at the 70-second deadline. Its
network/console errors were empty and its UI bytes matched the frozen candidate.
The frozen UI refreshes for passed retry/reset dates, not credit freshness expiry.
This is retained negative candidate evidence, not a harness error to suppress or
permission to silently qualify a repaired candidate. Other live browser transition
results were not reached in that fail-fast run.

A browser failure is evidence to diagnose, never permission to patch the candidate,
weaken the assertion or claim that worker data was browser proof. Native router
qualification and specialist verdicts remain separate even if all browser checks
pass. The current extension tests the native first page slot (Accounts); it does
not claim coverage of a separately rendered Usage page or dashboard widget.

## Selected replacement mapping controls and historical limitation

The selected replacement supports `connectionIds` on one raw-provider row. The
installed worker's `/config/test` RPC must accept a retained primary Codex binding,
its additive Sol alias and an unrelated provider; duplicate provider rows and
cross-provider alias ambiguity must still fail. Config validation must not mutate
usage. The lane then saves only that synthetic supported alias configuration and
requires the installed UI-data projection to retain the primary ID, include both
IDs, preserve unrelated bindings and avoid duplicating account/headroom counts or
refreshing telemetry. `installed-matrix.json` retains validation and actual values.
This is representation/projection evidence, not native routing evidence. Production
bindings are never read or changed.

Historical `c129014` installed `/config/test` receipts established the limitation
below; they remain negative evidence for that candidate only:

At the frozen candidate, `src/config.ts` accepts exactly one row per raw provider
and one `connectionId` per row. `src/router.ts` resolves that exact connection ID;
an unmatched connection remains selectable `unknown`, never measured headroom.
Changing the provider word to invent an alias would not match the raw telemetry
provider. Therefore this candidate cannot represent two distinct Codex connection
bindings simultaneously without changing one of those requirements. Configuration
validation is not a native member assessment and does not remove the blind spot.
No production configuration change, protocol switch or candidate repair is implied.
A separately selected candidate needs its own exact-candidate qualification.

Native pool inspection is not the plugin's router assessment. In the pinned stock
source, `server/src/services/ai-connection-router.ts:106–118` reports generic account
eligibility/cached usage. Its allocation path invokes `routeAiConnection` only after
authorizing candidates (`:205–275`). The pool branch of the supported adapter test
preview (`server/src/routes/agents.ts:3258–3261`) explicitly returns
`ai_connection_pool_task_test_required` without allocating a task or contacting a
provider. Neither surface establishes native router eligibility. Until a supported
synthetic task/allocation path within the no-inference boundary is exercised, native
member/model eligibility remains missing; do not substitute pool inspection or
loosen the fixture's inference refusal.

Preparation downloads the public stock image and locked candidate dependencies before
entering this network boundary. Browser execution must use the same network namespace,
synthetic credentials/data only and an explicit request allow-list. Neither the
fixture nor driver replaces global fetch or exposes a provider egress route.

Explicit container removal and absence verification run on normal/failure paths. The
`always()` step is **not** the cancellation guarantee: GitHub disposes the dedicated
hosted job VM, including container processes/layers and embedded database, even when
workflow steps cannot run after cancellation. No runtime or storage resource exists
outside that VM. Images are not provisioned services. There is no recurring idle
runtime charge, external volume, cloud database compute, Durable Object/alarm,
keep-alive, scheduled Worker, Stream input or added scheduler. Native host background
work cannot survive VM disposal; the heartbeat scheduler is disabled in this test
instance. Production is not touched.

Evidence upload has seven-day native artifact retention. A hard cancellation may
prevent final logs/upload; it must be reported as cancelled with incomplete evidence,
never qualified. The Actions job record remains the native disposal/run boundary.

## Dependency execution policy

No manifest or candidate lockfile update is made. Actions uses npm `11.19.0`, verifies
native `min-release-age=3` and `ignore-scripts=true`, then performs `npm ci` and the
named first-party build. The lock's install-hook candidates are esbuild `0.27.1` and
Darwin-only fsevents `2.3.3`; neither hook is enabled. esbuild's platform package is a
locked optional dependency, not a postinstall exception. No hook exceptions exist.
Existing locks are not retrospective publication-age/provenance proof. The stock
image is reused by immutable manifest/revision rather than rebuilt or installed from
fresh npm dependencies; Docker has no native npm-style release-age gate. This residual
image supply-chain limit and loaded artifact identities remain Security review scope.
No downloaded image or dependency is executed on the shared development host.

## Operation and completion

All policy tests, candidate builds and installed-host assertions run in GitHub Actions,
not locally. Keep the PR draft while any required qualification row is missing.
For PR events this workflow runs only when its lane changes. Manual dispatch is
available after the workflow lands; it creates no production path.

Stock lifecycle reference:
<https://github.com/paperclipai/paperclip/blob/d69631b01b9c658f80bf8bed389863dce82643e1/doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md>.

Before completion, retain exact-head required Actions/Devin checks, independent
review, Security acceptance covering the trust boundaries and exact candidate
hardening delta, and final QA/council review. This repository currently has only its
source CI workflow and no hosting deployments; the qualification workflow adds no
publish/deploy/promotion path. Recheck deployment classification before merge.

REA angle: reuse the published stock image and supported local-package lifecycle,
then feed existing synthetic credit/cooldown scenarios through installed runtime
surfaces. No parallel installer or service is introduced.
