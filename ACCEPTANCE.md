# Diagnostic tool acceptance record

**Not accepted or installed.** This file records required evidence, not an approval.
Maintainer: connector maintainers. Tool: `quota-diagnostics` (read); companion API:
`GET /diagnostics`. See [THREAT-MODEL.md](THREAT-MODEL.md).

## Release candidate identity (0.3.0)

- Candidate: `main` at `212da246cfe884cfb9feda75995c1659877a24b5` (package / manifest version `0.3.0`). No tag or release asset is cut from this record alone.
- Provenance: PR #24 merged as squash `1fd7aaa1848c47a56ea0d7154aab16c5f82a548f` (2026-11-08), followed by PR #26 (`70977553deb6bc6ad2cc77d9f37e3a3ea677c0ce`, served-set fallback preservation) and PR #25 (`212da246cfe884cfb9feda75995c1659877a24b5`, recognised-empty warning silencing), both merged 2026-11-10. At review time `212da24` is the candidate; merging this record advances `main` beyond it, so the candidate identity above is the exact code head, not a claim about the future `main` head.
- Previous released artifact: `v0.2.7` (no agent tools). This candidate is the first release carrying `quota-diagnostics`; the operator install must retain the `v0.2.7` artifact for rollback.

## Source and compatibility

- SDK dev dependency is lockfile-pinned to `2026.1023.0`; runtime tool/API context contracts were inspected from `2026.1106.0`.
- CLIProxy normalized quota fixtures follow the v8 SDK `QuotaFetchResponse`; discovery follows the v8 credential-list wrapper and 404-only v0 fallback. No live management API was called.
- Existing plugin remains in its own repository. No toolkit relocation, shared credential process, new credential, production dependency or installed-runtime patch is introduced. Test-only rendering and schema-validation dependencies are lockfile-pinned.
- Added permission request: `agent.tools.register`. Existing `api.routes.register`, `plugin.state.read` and `activity.log.write` support the diagnostic read path. Existing sync permissions remain, but diagnostics never invokes secret resolution or outbound fetch.

## Policy-to-test matrix

All rows below name authored fixtures; their execution must be established by exact-head GitHub Actions, not inferred from this table.

| Policy | Tests |
| --- | --- |
| Closed schema, unknown keys, traversal/control characters, malformed and fractional/out-of-range thresholds | `src/diagnostics.test.ts` — refuses closed-schema inputs |
| Authenticated scope, no caller tenant override, missing identity, unconfigured/foreign connection | registered-handler scope/refusal cases in `src/diagnostics.test.ts` |
| Exact pool override and threshold-100 agreement with router; no asserted native pool inventory | router-semantics case in `src/diagnostics.test.ts` |
| No credential resolution, outbound fetch or cache mutation; raw config/account/error canaries absent | registered-handler canary and reflected-error cases in `src/diagnostics.test.ts` |
| Per-principal rate boundary including malformed calls; audit failure refuses success; stalled reads/audits retain permits across timeout waves; nested work and elapsed deadline bounds | rate/audit/timeout/concurrency/nested-cache cases in `src/diagnostics.test.ts` |
| Optional catalog warnings do not count as quota failure; healthy siblings cannot mask stale/unknown observations; invalid persisted alias config refuses routing | health and `routeWithCache` cases in `src/plugin.test.ts` |
| Feature/malformed scopes do not satisfy account-wide Hopper completeness; credential-shaped metric keys are refused | typed normalized observation cases in `src/parsers.test.ts` |
| API method, query scope, extra keys, canonical integer conversion | GET API case in `src/diagnostics.test.ts` |
| v8 account-level discovery, explicit fallback precedence, disabled/unsupported/malformed entries | `src/sync.test.ts` discovery cases |
| Native numeric fields, unknown-is-not-zero, Codex balance age, Hopper completeness, Meta parity guard | `src/parsers.test.ts` typed normalized observations |
| Persistent page credit/reset/retry expiry, fresh-cache recovery, company switches, cleanup and slow background reads | `src/ui-refresh.test.ts` mounted-component cases; not installed/browser qualification |
| Empty aliases with a primary binding, nonempty alias-only binding, display-only errors versus unsafe routing configuration | `src/config-schema.test.ts` schema/parser and routing-safety cases |

No provisioning, mutation approval, spend reservation, TTL extension or teardown
cases apply: diagnostics makes zero provider requests and creates no resource.
Unknown tool dispatch is owned by the SDK exact-name registry, not a plugin
multiplexer. Native governance and durable host audit coverage are still required.

## Verification and open gates

- No local suite, typecheck or build is authorized or claimed. CI commands are `npm run typecheck`, `npm test`, `npm run build` on GitHub Actions.
- Exact-head evidence for this candidate: [Actions run 42900349101, check job 130124354294](https://github.com/TogetherWeOwn/paperclip-plugin-cliproxy-connector/actions/runs/42900349101/job/130124354294) on `212da246cfe884cfb9feda75995c1659877a24b5` — frozen install, typecheck, **17 files / 702 tests passed**, build. PR #24's reviewed head `41ece7dd83d778822c247c045f78a411fb0199a0` passed 679 tests ([Actions job 128619612498](https://github.com/TogetherWeOwn/paperclip-plugin-cliproxy-connector/actions/runs/42444206761/job/128619612498)); PR #25's head passed 702 tests, PR #26's head 696 tests. Only the `main`-head job above validates this candidate; earlier heads do not.
- Source review history: the complete-diff review and bounded repair deltas (native-field loss, unsafe metric keys, timeout/audit permit leaks, synchronous deadline gaps, health coverage, invalid persisted mappings, mounted-page freshness and deferred-read lifecycle) closed with native Security source approval and QA source approval for PR #24's reviewed head (see the security-review and qa-review documents on TWO-4424), followed by the pinned squash merge. Both approvals explicitly retained no-install: they are source approvals, not exact-artifact, host-governance, or installation acceptance.
- Delta since the PR #24 review (`1fd7aaa..212da24`, four files: `src/models.ts`, `src/models.test.ts`, `src/sync.ts`, `src/sync.test.ts`): PR #26 adds explicit list-container recognition so an unrecognized HTTP-200 payload retains quota/`owned_by` fallback evidence; PR #25 silences the catalog-wide empty warning only for a recognized empty per-file list and requires every file to 404 before the missing-endpoint report. The delta touches served-set evidence bookkeeping only — no diagnostic-tool, manifest, permission, dependency, workflow, credential, or logging change, and filename hashing, error scrubbing and display-metadata protection are unchanged. A Security delta acceptance for this candidate is still pending; do not treat the PR #24 source approvals or the per-PR fresh-context revalidations cited in those PRs as that acceptance.
- Exact artifact digest/configuration/permission-envelope Security acceptance: pending. This candidate is not a release artifact.
- Verify on the exact installation host that native registered tools traverse access governance and immutable call-event auditing. Narrow access to intended agents/projects, classify the tool read-only, and prove denied access cannot dispatch. No claim of this coverage is made from SDK declarations or offline fixtures.
- Verify activity and **all** identity/rate/capacity/deadline refusal worker records are durably captured with native call-event audit and intended retention/access controls. Saturation refusals deliberately do not enqueue activity RPCs. Missing durable refusal coverage is an open install gate, not a passed audit control. Local in-memory rate buckets are not a distributed quota; permanently hung host RPCs retain permits until actual settlement or Operator worker recovery.
- Verify deadline, concurrency, cache/output boundaries and negative controls in Actions; uncompleted evidence remains a gate, not an assumed pass.
- Meta fallback retirement remains gated on provider-contract parity: preserve malformed/missing-source semantics, canonical windows, tier identity and original observation/cache age, followed by accepted exact-version parity evidence. Do not remove the fallback based on these adapter changes.

## Operator runbook (only after the gates)

1. Install the independently reviewed release/digest through the supported plugin path; retain the prior accepted artifact/config for rollback. No new secret is needed by diagnostics.
2. Bind the minimum read-only tool access profile. Confirm the new capability does not grant access to unrelated tools or companies; run a deny-by-default canary on the actual host.
3. Read a configured alias through tool/API, and compare supplied pool inputs against authoritative native settings and the actual route result. Diagnostics itself does not read those native pool settings.
4. Separately apply the authorized alias/threshold configuration changes. Verify the intended connection is mapped and native threshold 100 is honored. No code fixture is live readback.
5. On failure revoke diagnostic access/disable the plugin and restore the prior accepted artifact/config. Do not clear management strikes, rotate credentials or weaken a required check as a rollback shortcut.
