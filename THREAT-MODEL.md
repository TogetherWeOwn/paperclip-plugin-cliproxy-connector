# Quota diagnostics threat model

Status: implementation candidate, not Security acceptance or installation authority.

## Boundary and credential ceiling

The existing connector sync worker has a configured CLIProxy management secret reference and optional client/OpenRouter references. Its management credential can exceed the connector's pinned read surface. Existing transport allowlists, management-auth strike budget, live-read switches and per-account throttles remain mandatory. Diagnostics does not resolve **any** credential, create a client, call a provider, trigger sync, download an auth file or clear strikes. It reuses only company-scoped config and normalized cached rows inside the same connector worker. Process compromise still exposes the worker's existing authority; a tool schema does not sandbox the process.

| Existing worker capability | Diagnostic tool capability | Forbidden |
| --- | --- | --- |
| Management key resolution / pinned upstream reads | None | Secret refs/values, URLs, headers, arbitrary endpoints, sync/refresh |
| Company plugin-state read/write | Read normalized rows for host-authenticated company | Cross-company scope, arbitrary state keys, writes/deletion |
| Router callback | Explain one mapped connection with the same aggregate function | Select a member, mutate a pool, claim a live pool readback |
| Activity log | Fixed diagnostic outcome record | Raw arguments, config, rows, exceptions or provider bodies |

## `quota-diagnostics` (read)

The one tool accepts a required configured `connectionId` and optional bounded ASCII `poolId`, `model`, integer `thresholdPercent` (1–100). Unknown properties, arrays, scalars, URL/header/credential fields and caller-supplied tenant identities are rejected in worker code, not merely by JSON Schema. Connection aliases must resolve in the authenticated company's configuration. It returns only an aggregate assessment, effective reserve and explicit assessment inputs; no account labels, emails, hashes, error text, plan text, secret references or raw quota payloads.

Company, agent and run identity come from the host `ToolRunContext`; absent or invalid required identity refuses before config/state reads. Project/task scope is not a resource selector: the intentionally company-level aggregate exposes no task/project records and cannot mutate them. Tool access must be narrowed by the installation's native access policy. Replayed calls are reads and do not refresh provider observations.

Optional pool inputs are **caller-supplied assessment inputs**, not native pool inventory. The response always says `nativePoolReadback: false`. The assessment uses the router's exact aggregate/reserve precedence, including per-pool overrides and threshold 100. A foreign/unconfigured connection refuses; a pool ID cannot select another company's config.

## `GET /diagnostics` (read API)

The manifest requires `board-or-agent` authentication and host company resolution from the `companyId` query. The worker uses the immutable host company/actor context, rejects a mismatched or repeated query company, unexpected query fields, non-GET methods and nonempty bodies. Numeric query conversion accepts only canonical integers 1–100. The same validation, output projection, limits and audit apply as the tool. This is not an authorization-header proxy. The existing board-only re-enable route is separate and unchanged.

## Abuse, lifecycle and audit

- Code caps: 30 admitted attempts (valid or malformed) per principal/company per minute across both transports, four concurrent operations **including audit**, at most 1,024 live rate buckets, 2,000 cached rows, 256 limits per row / 10,000 total limits, 100 models per limit / 20,000 total model references, bounded identifiers, 32 KiB serialized output, five-second response deadline. General configuration parsing is preceded by an eight-level / 20,000-node JSON bound. Rate buckets expire after one minute and reset on worker restart; these are worker-local abuse bounds, not a claimed durable distributed quota. Native access/rate policy remains required.
- No resources, credentials or billable provider requests are created: resource TTL, spend reservation and teardown are not applicable. Provider request/spend cap is zero. There is nothing to extend, orphan or delete.
- Admitted attempts record fixed outcome, call ID, host company/principal/run, transport, tool/policy identity, timestamp and duration through `ctx.activity.log`. Audit failure suppresses the diagnostic result. Identity/capacity/rate/deadline refusals instead emit a fixed host-captured refusal record with safe identity and call ID: they must not enqueue more activity RPCs while saturated. No untrusted arguments/errors are logged. Durable capture of **both** native call events and worker refusal logs, plus retention/access controls, is an explicit unproven acceptance prerequisite. This fallback is not asserted to meet the standard merely because the logger exists.
- Deadline expiry cannot cancel an already-issued host read/audit RPC. Its operation retains the concurrency permit until the RPC actually settles; a hung RPC therefore reduces capacity and may require Operator recovery, never permit reclamation that launches unbounded work. No further RPC starts after deadline. Bounds precede synchronous aggregation, and elapsed time is checked after parsing, aggregation, serialization and audit before success. No retry is performed.
- Task text, upstream strings and malformed cache content cannot choose a credential, destination, tenant or write operation. Reflected host errors produce fixed codes. Synthetic canaries in config and account metadata must not appear in results or audit.

## Residual risks and installation gates

The SDK tool path's native governance and immutable call-event coverage must be verified on the exact target host before installation. Declaration of `agent.tools.register` is not proof of authorization-policy enforcement. An unsupported or unclassified tool path remains an open control gap. Security must accept the exact source/artifact and capability envelope; only an Operator may install/configure it. Revocation: disable the tool's native access profile or plugin, retain existing sync kill switches/strike state, and roll back to the prior accepted artifact. No new credential is needed for diagnostics.

REA angle: reuse the installed SDK's immutable tool/API contexts and existing router aggregation rather than introduce another credential broker or scheduler.
