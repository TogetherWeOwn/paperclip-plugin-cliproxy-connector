# Diagnostic tool acceptance record

**Not accepted or installed.** This file records required evidence, not an approval.
Maintainer: connector maintainers. Tool: `quota-diagnostics` (read); companion API:
`GET /diagnostics`. See [THREAT-MODEL.md](THREAT-MODEL.md).

## Source and compatibility

- SDK dev dependency is lockfile-pinned to `2026.1023.0`; runtime tool/API context contracts were inspected from `2026.1106.0`.
- CLIProxy normalized quota fixtures follow the v8 SDK `QuotaFetchResponse`; discovery follows the v8 credential-list wrapper and 404-only v0 fallback. No live management API was called.
- Existing plugin remains in its own repository. No toolkit relocation, shared credential process, new credential, dependency or installed-runtime patch is introduced.
- Added permission request: `agent.tools.register`. Existing `api.routes.register`, `plugin.state.read` and `activity.log.write` support the diagnostic read path. Existing sync permissions remain, but diagnostics never invokes secret resolution or outbound fetch.

## Policy-to-test matrix

All rows below name authored fixtures; their execution must be established by exact-head GitHub Actions, not inferred from this table.

| Policy | Tests |
| --- | --- |
| Closed schema, unknown keys, traversal/control characters, malformed and fractional/out-of-range thresholds | `src/diagnostics.test.ts` — refuses closed-schema inputs |
| Authenticated scope, no caller tenant override, missing identity, unconfigured/foreign connection | registered-handler scope/refusal cases in `src/diagnostics.test.ts` |
| Exact pool override and threshold-100 agreement with router; no asserted native pool inventory | router-semantics case in `src/diagnostics.test.ts` |
| No credential resolution, outbound fetch or cache mutation; raw config/account/error canaries absent | registered-handler canary and reflected-error cases in `src/diagnostics.test.ts` |
| Per-principal rate boundary; audit failure refuses success | rate/audit case in `src/diagnostics.test.ts` |
| API method, query scope, extra keys, canonical integer conversion | GET API case in `src/diagnostics.test.ts` |
| v8 account-level discovery, explicit fallback precedence, disabled/unsupported/malformed entries | `src/sync.test.ts` discovery cases |
| Native numeric fields, unknown-is-not-zero, Codex balance age, Hopper completeness, Meta parity guard | `src/parsers.test.ts` typed normalized observations |

No provisioning, mutation approval, spend reservation, TTL extension or teardown
cases apply: diagnostics makes zero provider requests and creates no resource.
Unknown tool dispatch is owned by the SDK exact-name registry, not a plugin
multiplexer. Native governance and durable host audit coverage are still required.

## Verification and open gates

- No local suite, typecheck or build is authorized or claimed. CI commands are `npm run typecheck`, `npm test`, `npm run build` on GitHub Actions.
- Exact-head Actions evidence for these additions: pending.
- One fresh-context complete-diff review, native Security and QA decisions: pending.
- Exact artifact digest/configuration/permission-envelope Security acceptance: pending. This candidate is not a release artifact.
- Verify on the exact installation host that native registered tools traverse access governance and immutable call-event auditing. Narrow access to intended agents/projects, classify the tool read-only, and prove denied access cannot dispatch. No claim of this coverage is made from SDK declarations or offline fixtures.
- Verify activity and missing-identity worker logs are durable and subject to the intended retention/access controls. Local in-memory rate buckets are not a distributed quota.
- Verify deadline, concurrency, cache/output boundaries and negative controls in Actions; uncompleted evidence remains a gate, not an assumed pass.
- Meta fallback retirement remains gated on provider-contract parity: preserve malformed/missing-source semantics, canonical windows, tier identity and original observation/cache age, followed by accepted exact-version parity evidence. Do not remove the fallback based on these adapter changes.

## Operator runbook (only after the gates)

1. Install the independently reviewed release/digest through the supported plugin path; retain the prior accepted artifact/config for rollback. No new secret is needed by diagnostics.
2. Bind the minimum read-only tool access profile. Confirm the new capability does not grant access to unrelated tools or companies; run a deny-by-default canary on the actual host.
3. Read a configured alias through tool/API, and compare supplied pool inputs against authoritative native settings and the actual route result. Diagnostics itself does not read those native pool settings.
4. Separately apply the authorized alias/threshold configuration changes. Verify the intended connection is mapped and native threshold 100 is honored. No code fixture is live readback.
5. On failure revoke diagnostic access/disable the plugin and restore the prior accepted artifact/config. Do not clear management strikes, rotate credentials or weaken a required check as a rollback shortcut.
