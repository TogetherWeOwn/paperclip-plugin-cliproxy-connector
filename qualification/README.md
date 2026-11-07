# Disposable stock-host qualification

## Current state: preflight only, not qualified

This draft lane currently measures supported stock-host startup, exact local-path
candidate installation, disable/enable, a real worker data RPC and artifact identity.
A successful `stock-host` preflight job **does not qualify the candidate**. The
installed credit/cooldown/isolation scenario matrix, persistence/refresh transitions,
native router eligibility, actual browser assertions/screenshots/traces and specialist
acceptance are still required. Do not use this lane as installation authority.

## Identity

- Candidate: `c129014d765b400d8e547ff469499cd3c34429ff`, independently checked out,
  built with its unchanged lockfile and SDK `2026.1023.0`.
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
- `preflight.json` records installed package path and its artifact hashes, the actual
  stock runtime identity and successful/failed checks. Hashing a UI bundle is not
  browser-load proof. Registry health is not worker RPC proof; the data bridge is
  called separately after enable.

The source digest, image digest, runtime/package identity and candidate artifact
are separate facts. An unavailable artifact or failed assertion is a failure, not
permission to substitute main, a different host, an SDK bump or a core patch.

## Resource and network boundary

The only runtime is one GitHub-hosted `ubuntu-24.04` job with a 25-minute ceiling.
The stock container has no network interface other than loopback (`--network none`),
no published ports, no Docker socket, no production mount, no forwarded job token
and no external database. Embedded PostgreSQL and instance state live in its writable
container layer. Candidate and driver mounts are read-only; the only writable host
mount is the job-local evidence directory. A documentation-address negative control
checks that non-loopback egress cannot succeed. No provider or management call occurs
in the current preflight.

Preparation downloads the public stock image and locked candidate dependencies before
entering this network boundary. Future fixtures/browser execution must use the same
network namespace, synthetic credentials/data only and an explicit request allow-list.
They must not replace global fetch or expose a provider egress route.

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
