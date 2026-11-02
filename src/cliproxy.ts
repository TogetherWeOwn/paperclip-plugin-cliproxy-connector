/**
 * Safe CLIProxy management client (proposal §4).
 *
 * Defence in depth, all enforced here rather than at call sites:
 * - loopback-only base URL, validated at construction and re-validated per call
 * - key header attached only after origin validation
 * - GET-only allow-list; `api-call` is excluded from the GET path and can never
 *   be admitted through it (it executes upstream requests with stored upstream
 *   credentials, so "GET-only" would be a lie). The only `api-call` use is the
 *   pinned POST below: five hard-coded request templates whose only variable
 *   is the credential `authIndex` — no caller can supply a URL, headers or body
 * - `redirect: "manual"` with re-validation of every hop (max 2, same-origin
 *   loopback only)
 * - 15 s timeouts, size-capped bodies, JSON schema-checked before storage
 * - the key never appears in errors, logs or persisted state (see redaction
 *   tests in `cliproxy.test.ts`)
 *
 * Agents never touch this client: it runs in the plugin worker sync job, the
 * key is resolved per run from a `secret_ref` and kept in memory only.
 */

import { SINGLE_SEGMENT, isLoopbackUrl, stripTrailingSlashes } from "./config.js";

export const MANAGEMENT_TIMEOUT_MS = 15_000;
export const MANAGEMENT_MAX_BYTES = 2 * 1024 * 1024;
export const MANAGEMENT_MAX_REDIRECTS = 2;

/**
 * Pinned management paths (fixed shapes, never config strings). The key is
 * only ever attached to these two shapes; `api-call` can never be admitted
 * because no pinned shape contains it. `pluginId` is validated to a single
 * path segment before substitution.
 *
 * The management key is never sent to `/v1` paths: the served model list
 * below uses the separate *client* API key through `CliproxyClientApiClient`.
 * That separation is why `cliproxy.test.ts` still asserts that a redirect to
 * `/v1/models` from a management GET is refused.
 */
export const AUTH_FILES_PATH = "/v0/management/auth-files";
const PLUGIN_QUOTA_SHAPE = /^\/v0\/management\/plugins\/[A-Za-z0-9][A-Za-z0-9_-]*\/quota$/;

/**
 * Pinned auth-file download path (stock CLIProxy `DownloadAuthFile`): the raw
 * file bytes for one auth file, addressed by exactly one `name` query value.
 * Stock 400s on unsafe names and on names without a `.json` suffix, 404s when
 * the file is absent. The response is credential-bearing by nature (refresh
 * tokens, `dca_token`), so callers extract the one field they need and drop
 * the text immediately — it is never logged, persisted or attached to state.
 */
export const AUTH_FILE_DOWNLOAD_PATH = "/v0/management/auth-files/download";

/**
 * Pinned request-count shape: `GET /v0/management/api-key-usage` (v8:
 * `/observability/usage/api-keys`, same handler — the v0 path stays the only
 * admitted one). Per-provider request counts (success/failed + recent
 * buckets) for `api_key` auths, keyed `base_url|api_key`. The worker
 * aggregates by provider and discards the composite keys before any state
 * write (see `src/request-counts.ts`, threat T1). Query strings are refused:
 * the endpoint takes no parameters.
 */
export const API_KEY_USAGE_PATH = "/v0/management/api-key-usage";

/**
 * Pinned `api-call` management path. POST-only, and only reachable
 * through `postApiCall` with one of the frozen templates below — the
 * GET allow-list (`assertAllowListed`) still refuses this path outright.
 *
 * `POST /v0/management/api-call` proxies one request to the provider using the
 * stored credential selected by `auth_index` (CLIProxyAPI
 * `internal/api/handlers/management/api_tools.go`: `APICall`). The request
 * carries the `$TOKEN$` placeholder where the panel sends a credential; the
 * backend substitutes the stored credential server-side (`resolveTokenForAuth`
 * — per-provider refresh/mint, including the JSON-escaped substitution inside
 * `data`), so the plugin never handles, logs or persists credential material.
 * Provider-side behavior stays backend-owned: the connector sees only the
 * returned envelope and cannot scope server-side substitution or any upstream
 * redirect the backend follows.
 */
export const API_CALL_PATH = "/v0/management/api-call";

/**
 * One pinned upstream request behind `POST /v0/management/api-call`. Every
 * field is a frozen literal copied from the Management Center panel source
 * (cited per template); per-account variables (`authIndex`, and `projectId`
 * for the Antigravity quota templates) are supplied separately at call time
 * and validated before any network happens.
 */
export interface ApiCallTemplate {
  /** Provider family this template serves (`antigravity`, `devin`). */
  provider: string;
  method: "POST";
  /** Exact upstream URL — never built from input. */
  url: string;
  /** Exact upstream headers. `$TOKEN$` is substituted server-side by CLIProxy. */
  headers: Record<string, string>;
  /**
   * Exact upstream body. `$TOKEN$` is substituted server-side by CLIProxy.
   * Quota templates carry the placeholder `PROJECT_ID_SENTINEL` instead of a
   * literal body: `postApiCall` replaces it with the validated project id via
   * `JSON.stringify`, so the id can never break out of its JSON string.
   */
  data: string;
  /** When true, the caller must supply a validated `projectId`. */
  requiresProjectId?: true;
}

/**
 * Runtime-freeze one pinned template, including its nested headers object.
 * The `as const` assertion is compile-time only; without this, a caller
 * holding a returned template could mutate the shared table entry.
 */
function freezeApiCallTemplate(template: ApiCallTemplate): ApiCallTemplate {
  Object.freeze(template.headers);
  return Object.freeze(template);
}

/**
 * Return a defensive copy of a frozen template: selections can read the
 * pinned fields but cannot alter the shared frozen entry through the result.
 */
function copyApiCallTemplate(template: ApiCallTemplate): ApiCallTemplate {
  return { ...template, headers: { ...template.headers } };
}

/**
 * The pinned `api-call` templates. Frozen: callers select by key
 * (`ApiCallTemplateKey`) and can never supply their own URL, headers or body,
 * so the guarded POST below cannot send an arbitrary upstream request.
 *
 * There is deliberately NO Meta template. The panel's Meta quota call (panel
 * `src/features/quota/providers/meta/requests.ts`: `method: 'POST'`,
 * `url: META_MUSE_QUOTA_URL` (`'https://api.meta.ai/muse-code/key'`), `header`
 * with `Accept: 'application/json'`, `'Content-Type': 'application/json'`,
 * ``Authorization: `Bearer ${dcaToken}```, `'x-api-version': '1.0.0'`,
 * `data: '{}'`, and `authIndex` passed as a separate top-level request
 * argument) authorizes with the `dca_token` it reads from the DOWNLOADED auth
 * file (`downloadText(file.name)` → `JSON.parse` → `dca_token`, which must
 * match `/^dca:[^\s]+$/`) — never with the backend's server-side `$TOKEN$`
 * substitution (`resolveTokenForAuth` → `metaTokenFromAuth`), which never
 * yields that downloaded token. A frozen `muse-code/key` template with
 * `Bearer $TOKEN$` could only ever return HTTP 401, so Meta rides a dedicated
 * method instead (`postMetaMuseCodeKey`): the caller downloads the auth file,
 * extracts the `dca_token`, and the method sends it as a literal per-call
 * `Authorization` header. Stock `api_tools.go` passes headers without
 * `$TOKEN$` through untouched, so the literal bearer reaches the provider
 * exactly as the panel sends it. The token lives in memory for that one call
 * only — never persisted, logged, or placed in errors, activity, metrics,
 * plugin state or UI payloads — and the downloaded body is dropped right
 * after extraction.
 *
 * - Antigravity subscription: the Code Assist subscription call (panel
 *   `src/services/api/antigravitySubscription.ts`
 *   `antigravitySubscriptionApi.get(authIndex)`: `method: 'POST'`,
 *   `url: ANTIGRAVITY_CODE_ASSIST_URL`
 *   (`'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'`),
 *   `header: { ...ANTIGRAVITY_REQUEST_HEADERS }`,
 *   `data: CODE_ASSIST_REQUEST_BODY`
 *   (`JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })`), with
 *   `authIndex` as a separate top-level argument; header constants in panel
 *   `src/utils/quota/constants.ts`: `Authorization: 'Bearer $TOKEN$'`,
 *   `'Content-Type': 'application/json'`,
 *   `'User-Agent': ANTIGRAVITY_USER_AGENT`
 *   (`'antigravity/hub/2.23.0 darwin/arm64'`)). Plan evidence only — the
 *   subscription answer carries no quota windows, so the quota templates
 *   below supply them. The backend refreshes the OAuth access token
 *   server-side for antigravity credentials.
 * - Antigravity quota (×3): the `retrieveUserQuotaSummary` endpoints the panel
 *   tries in order (panel `src/utils/quota/constants.ts`
 *   `ANTIGRAVITY_QUOTA_URLS`: daily → sandbox → cloudcode, iterated by
 *   `fetchQuotaPayload` in `src/features/quota/providers/antigravity/data.ts`
 *   as `for (const url of ANTIGRAVITY_QUOTA_URLS)` with
 *   `method: 'POST'`, `header: { ...ANTIGRAVITY_REQUEST_HEADERS }` and
 *   `data: JSON.stringify({ project: projectId })`, `authIndex` separate).
 *   The project id resolves via `resolveAntigravityProjectId`: entry
 *   `project_id ?? projectId`, then `metadata`, then `attributes`
 *   (`project_id ?? projectId ?? gemini_virtual_project`), then the downloaded
 *   file (`top-level`, `installed`, `web`) — the connector uses the same chain
 *   minus the download, which it never performs; `postApiCall` injects the id
 *   via `JSON.stringify`. Template key order below matches the panel's try
 *   order.
 * - Devin: the live seat-management RPC (panel
 *   `src/features/quota/providers/devin/requests.ts`
 *   `createDevinQuotaFetcher`: `method: 'POST'`,
 *   `url: 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'`,
 *   `header` with `'Content-Type': 'application/json'` and
 *   `'Connect-Protocol-Version': '1'`, `data` as the chisel metadata JSON
 *   whose `apiKey` is `$TOKEN$`, `authIndex` separate). It reads the live RPC,
 *   not auth-file `quota.signals`.
 */
const API_CALL_TEMPLATES = {
  antigravity: freezeApiCallTemplate({
    provider: "antigravity",
    method: "POST",
    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    headers: {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
    },
    data: '{"metadata":{"ideType":"ANTIGRAVITY"}}',
  }),
  "antigravity-quota-daily": freezeApiCallTemplate({
    provider: "antigravity",
    method: "POST",
    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer $TOKEN$",
      "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
    },
    data: '{"project":"PROJECT_ID_SENTINEL"}',
    requiresProjectId: true,
  }),
  "antigravity-quota-sandbox": freezeApiCallTemplate({
    provider: "antigravity",
    method: "POST",
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer $TOKEN$",
      "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
    },
    data: '{"project":"PROJECT_ID_SENTINEL"}',
    requiresProjectId: true,
  }),
  "antigravity-quota-cloudcode": freezeApiCallTemplate({
    provider: "antigravity",
    method: "POST",
    url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer $TOKEN$",
      "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
    },
    data: '{"project":"PROJECT_ID_SENTINEL"}',
    requiresProjectId: true,
  }),
  devin: freezeApiCallTemplate({
    provider: "devin",
    method: "POST",
    url: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    data: '{"metadata":{"ideName":"chisel","ideVersion":"3000.10.21","apiKey":"$TOKEN$","locale":"en","os":"darwin","extensionVersion":"3000.10.21","clientName":"chisel"}}',
  }),
} as const satisfies Record<string, ApiCallTemplate>;
Object.freeze(API_CALL_TEMPLATES);

/**
 * The `PROJECT_ID_SENTINEL` placeholder inside quota template bodies. It is a
 * compile-time marker only: `postApiCall` replaces it with the validated
 * project id via `JSON.stringify`, so the id can never break out of its JSON
 * string, and a project id that literally equals the sentinel is rejected.
 */
const PROJECT_ID_SENTINEL = "PROJECT_ID_SENTINEL";

/**
 * Single safe Antigravity project id (`{"project": …}` body field). GCP-style
 * project ids (lowercase letters, digits, hyphens/colons for domain-scoped
 * ids, dots, slashes for organization paths): starts alphanumeric, bounded,
 * no whitespace, no quotes, no backslashes, no `$` (no substitution games),
 * and can never equal the body placeholder above.
 */
export const API_CALL_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isSafeApiCallProjectId(value: string): boolean {
  return (
    API_CALL_PROJECT_ID_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.includes("$") &&
    value !== PROJECT_ID_SENTINEL
  );
}

/**
 * Ordered Antigravity quota template keys: the panel's try order (panel
 * `ANTIGRAVITY_QUOTA_URLS`), most likely to answer first. The sync loop tries
 * them in this order per account per sync and remembers the first key whose
 * answer carries quota groups.
 */
export const ANTIGRAVITY_QUOTA_TEMPLATE_KEYS = [
  "antigravity-quota-daily",
  "antigravity-quota-sandbox",
  "antigravity-quota-cloudcode",
] as const satisfies readonly ApiCallTemplateKey[];

export type ApiCallTemplateKey = keyof typeof API_CALL_TEMPLATES;

/** Select a frozen template by key. Unknown keys reject before any network happens. */
export function apiCallTemplate(key: string): ApiCallTemplate {
  if (!Object.prototype.hasOwnProperty.call(API_CALL_TEMPLATES, key)) {
    throw new CliproxyConfigError(`refusing an api-call request for an unknown provider: ${key}`);
  }
  const template = (API_CALL_TEMPLATES as Record<string, ApiCallTemplate>)[key] as ApiCallTemplate;
  return copyApiCallTemplate(template);
}

/** All pinned template keys (one per provider family served through `api-call`). */
export function apiCallTemplateKeys(): ApiCallTemplateKey[] {
  return Object.keys(API_CALL_TEMPLATES) as ApiCallTemplateKey[];
}

/**
 * Exact subscription-template allow-map from an auth file's raw provider word
 * to its pinned template key. Only `antigravity` and `devin` resolve.
 * `meta` deliberately resolves to null: Meta has no frozen template — it
 * rides the dedicated `postMetaMuseCodeKey` method with its per-call literal
 * bearer (see the table comment) — so template dispatch never calls Meta
 * accounts. Anything else — `gemini`, `gemini-cli`, `metafoo`, future
 * provider words — returns null and is never called. This is deliberately
 * NOT `normalizeProvider`: fuzzy/substring matching would send one account's
 * stored credential through another family's request (e.g. a Gemini token as
 * Bearer to the Antigravity Code Assist URL). Callers compare the trimmed,
 * lowercased raw provider string for exact equality only.
 */
export function apiCallTemplateKeyForProvider(rawProvider: string): ApiCallTemplateKey | null {
  const word = rawProvider.trim().toLowerCase();
  if (word === "antigravity" || word === "devin") return word;
  return null;
}

/**
 * Ordered quota-template keys for an auth file's raw provider word. Only
 * `antigravity` resolves (to the panel-order quota keys); every other word —
 * including `meta` (dedicated method, not templates) — returns an empty array
 * and gets no quota call.
 */
export function apiCallQuotaTemplateKeysForProvider(rawProvider: string): ApiCallTemplateKey[] {
  if (rawProvider.trim().toLowerCase() === "antigravity") {
    return [...ANTIGRAVITY_QUOTA_TEMPLATE_KEYS];
  }
  return [];
}

/**
 * Pinned per-credential served-set path (TWO-679 round 2, approved 09:24Z
 * design input): `GET /v0/management/auth-files/models?name=<file>`
 * (`GetAuthFileModels`). One GET per enabled auth file per sync; the `name`
 * query value is the auth-files entry `name`, validated as a single safe
 * value before any network happens. Same management key, same strike and
 * timeout rules as the other management paths.
 */
export const AUTH_FILE_MODELS_PATH = "/v0/management/auth-files/models";

/**
 * Single safe plugin-quota `auth_index` value: the credential index from the
 * `auth-files` list (`GET /v0/management/plugins/<id>/quota?auth_index=…`,
 * required since CLIProxy v8.0.49). Stored indexes are hex, but an operator
 * seed may widen the alphabet — so this admits a conservative token (bounded,
 * no separators, no traversal) rather than hex-only. `..` is rejected
 * separately, and `api-call` can never appear anywhere in the request.
 */
export const AUTH_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/;

export function isSafeAuthIndex(value: string): boolean {
  return (
    AUTH_INDEX_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.toLowerCase().includes("api-call")
  );
}

/**
 * Single safe auth-file name: starts alphanumeric, then alphanumerics, dots,
 * underscores, hyphens, `@` or `+` (CLIProxy OAuth flows generate email-style
 * file names such as `antigravity-user@example.com.json`; rejecting them would
 * silently drop those credentials' live served evidence). `..` is rejected
 * separately, and `api-call` can never appear in the pathname (the ban runs
 * on the decoded path, as for every pinned shape).
 */
export const AUTH_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,255}$/;

export function isSafeAuthFileName(name: string): boolean {
  return (
    AUTH_FILE_NAME_PATTERN.test(name) &&
    !name.includes("..") &&
    !name.toLowerCase().includes("api-call")
  );
}

export function authFileModelsPath(name: string): string {
  if (!isSafeAuthFileName(name)) {
    throw new CliproxyConfigError(`refusing to build a served-set path from an untrusted auth-file name: ${name}`);
  }
  return `${AUTH_FILE_MODELS_PATH}?name=${encodeURIComponent(name)}`;
}

/**
 * Pinned auth-file download path for one file name. Stock 400s on names
 * without a `.json` suffix, so the suffix is required here too — a suffixless
 * name rejects before any network happens instead of burning a request that
 * can only fail. The `name` value itself never appears in error messages.
 */
export function authFileDownloadPath(name: string): string {
  if (!isSafeAuthFileName(name)) {
    throw new CliproxyConfigError(`refusing to build an auth-file download path from an untrusted auth-file name`);
  }
  if (!name.toLowerCase().endsWith(".json")) {
    throw new CliproxyConfigError(`refusing to build an auth-file download path for a name without a .json suffix`);
  }
  return `${AUTH_FILE_DOWNLOAD_PATH}?name=${encodeURIComponent(name)}`;
}

/**
 * Exact upstream URL for the Meta Muse-key quota read, copied from the panel
 * (`META_MUSE_QUOTA_URL` in panel
 * `src/features/quota/providers/meta/requests.ts`). Never built from input.
 */
export const META_MUSE_CODE_KEY_URL = "https://api.meta.ai/muse-code/key";

/**
 * Downloaded `dca_token` shape (panel `readDcaToken`): `dca:` plus a
 * non-blank remainder, no whitespace. Anything else is "no usable token" —
 * never a partial credential.
 */
export const DCA_TOKEN_PATTERN = /^dca:[^\s]+$/;

/** Upper bound on an accepted `dca_token`, so a hostile file cannot stuff an unbounded bearer into the request. */
export const DCA_TOKEN_MAX_LENGTH = 4096;

/**
 * Extract only the `dca_token` field from a downloaded auth-file body — the
 * panel's `readDcaToken`, minus its error codes (this client reports plain
 * non-secret messages instead). The caller drops the body right after this
 * returns; the token itself lives in memory for one `postMetaMuseCodeKey`
 * call only. Throws `CliproxyBodyError` with messages that never quote the
 * file: a hostile or screen-scraped body must not smuggle secrets into logs.
 */
export function readDcaTokenFromAuthFile(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliproxyBodyError(`auth-file download is not JSON; skipping live Meta quota.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliproxyBodyError(`auth-file download is not an object; skipping live Meta quota.`);
  }
  const raw = (value as Record<string, unknown>).dca_token;
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!DCA_TOKEN_PATTERN.test(token) || token.length > DCA_TOKEN_MAX_LENGTH) {
    throw new CliproxyBodyError(`auth-file download carries no usable dca_token; skipping live Meta quota.`);
  }
  return token;
}

/**
 * Pinned client path (fixed shape, never a config string). The only GET the
 * client API key is ever attached to: the served model list that drives
 * model → provider derivation. Same guarded-fetch rules as the management
 * path (loopback, manual redirects, timeouts, size caps, no key leaks).
 */
export const MODELS_PATH = "/v1/models";

export function pluginQuotaPath(pluginId: string, authIndex?: string | null): string {
  if (!SINGLE_SEGMENT.test(pluginId)) {
    throw new CliproxyConfigError(`refusing to build a quota path from an untrusted plugin id: ${pluginId}`);
  }
  if (authIndex === undefined || authIndex === null) {
    // Legacy provider-level shape (older CLIProxy builds that predate the
    // required `auth_index` query parameter). Current builds always send one.
    return `/v0/management/plugins/${pluginId}/quota`;
  }
  if (!isSafeAuthIndex(authIndex)) {
    throw new CliproxyConfigError(`refusing to build a quota path from an untrusted auth index`);
  }
  return `/v0/management/plugins/${pluginId}/quota?auth_index=${encodeURIComponent(authIndex)}`;
}

export class CliproxyConfigError extends Error {}
/**
 * The endpoint does not exist (or the named file does not). Callers treat
 * this as best-effort degradation (served-set → heuristic fallback), never
 * as an auth failure: it spends no strike budget.
 */
export class CliproxyNotFoundError extends Error {
  constructor(path: string) {
    super(`CLIProxy has no served-set for this request (HTTP 404 on ${path})`);
    this.name = "CliproxyNotFoundError";
  }
}
export class CliproxyAuthError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`CLIProxy management rejected the key (HTTP ${status} on ${path})`);
    this.name = "CliproxyAuthError";
    this.status = status;
  }
}
export class CliproxyRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliproxyRedirectError";
  }
}
export class CliproxyBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliproxyBodyError";
  }
}
export class CliproxyNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliproxyNetworkError";
  }
}

/** The client only ever GETs string URLs; keep the type structural. */
export type ManagementFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CliproxyClientOptions {
  baseUrl: string;
  keyHeader: string;
  /** Resolved management key. In memory only; never logged or persisted. */
  key: string;
  fetchImpl?: ManagementFetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Decode a pathname for allow-list comparison. Percent-encoding must not
 * smuggle a blocked path past the check (`api%2Dcall`, `..%2F…`), so the
 * allow-list and the `api-call` ban both run on the decoded form.
 */
function decodedPathname(url: URL, what: string): string {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new CliproxyConfigError(`undecodable management path (${what})`);
  }
  // Decoded traversal or embedded separators mean the raw path was hostile.
  if (pathname.includes("..") || pathname.includes("\\")) {
    throw new CliproxyConfigError(`refusing a management path that decodes hostile (${what})`);
  }
  return pathname;
}

function assertAllowListed(url: URL, what: string): void {
  const pathname = decodedPathname(url, what);
  if (pathname.toLowerCase().includes("api-call")) {
    throw new CliproxyConfigError("`api-call` is excluded from the allow-list and can never be called.");
  }
  if (pathname === AUTH_FILE_DOWNLOAD_PATH) {
    // Pinned download shape: exactly one `name` param, and it must be a
    // single safe value (validated the same way as at path-build time, so a
    // hostile redirect target cannot smuggle a traversal past the check).
    // The suffix is a path-build-time rule only: a redirect target that
    // drops it still matches this pinned shape and stays a download.
    const keys = [...url.searchParams.keys()];
    const names = url.searchParams.getAll("name");
    if (keys.length !== 1 || keys[0] !== "name" || names.length !== 1 || !isSafeAuthFileName(names[0] as string)) {
      throw new CliproxyConfigError(`auth-file download has an unsafe name parameter (${what})`);
    }
    return;
  }
  if (pathname === AUTH_FILE_MODELS_PATH) {
    // Pinned served-set shape: exactly one `name` param, and it must be a
    // single safe value (validated the same way as at path-build time, so a
    // hostile redirect target cannot smuggle a traversal past the check).
    const keys = [...url.searchParams.keys()];
    const names = url.searchParams.getAll("name");
    if (keys.length !== 1 || keys[0] !== "name" || names.length !== 1 || !isSafeAuthFileName(names[0] as string)) {
      throw new CliproxyConfigError(`served-set request has an unsafe name parameter (${what})`);
    }
    return;
  }
  if (PLUGIN_QUOTA_SHAPE.test(pathname)) {
    // Pinned plugin-quota shape: no query (legacy provider-level fetch on
    // older builds), or exactly one `auth_index` with a single safe value.
    // Any other parameter — or an unsafe value, including one smuggled in via
    // percent-encoding (searchParams decodes before this check) — rejects
    // before any network happens, on initial and redirect-target URLs alike.
    const keys = [...url.searchParams.keys()];
    if (keys.length === 0) return;
    const indexes = url.searchParams.getAll("auth_index");
    if (
      keys.length !== 1 ||
      keys[0] !== "auth_index" ||
      indexes.length !== 1 ||
      !isSafeAuthIndex(indexes[0] as string)
    ) {
      throw new CliproxyConfigError(`plugin quota request has an unsafe query (${what})`);
    }
    return;
  }
  if (pathname === API_KEY_USAGE_PATH) {
    // Pinned request-count shape: no query string (the endpoint takes no
    // parameters). Anything else — including a smuggled query that could
    // alter the read — rejects before any network happens.
    if ([...url.searchParams.keys()].length > 0) {
      throw new CliproxyConfigError(`api-key-usage request carries no query string (${what})`);
    }
    return;
  }
  if (pathname !== AUTH_FILES_PATH) {
    throw new CliproxyConfigError(`path is outside the pinned GET allow-list: ${pathname}`);
  }
}

function assertModelsAllowListed(url: URL, what: string): void {
  const pathname = decodedPathname(url, what);
  if (pathname.toLowerCase().includes("api-call")) {
    throw new CliproxyConfigError("`api-call` is excluded from the allow-list and can never be called.");
  }
  if (pathname !== MODELS_PATH) {
    throw new CliproxyConfigError(`path is outside the pinned client GET allow-list: ${pathname}`);
  }
}

/**
 * Pinned `api-call` POST allow-list. The ONLY path the guarded POST
 * below may address: exactly `/v0/management/api-call` with no query string.
 * Template contents (upstream URL, headers, body) are never part of the URL —
 * they travel in the POST body built internally from a frozen template — so a
 * redirect target either matches this shape (same pinned path, same body
 * re-sent) or the hop is refused.
 */
function assertApiCallAllowListed(url: URL, what: string): void {
  const pathname = decodedPathname(url, what);
  if (pathname !== API_CALL_PATH) {
    throw new CliproxyConfigError(`path is outside the pinned api-call POST allow-list: ${pathname}`);
  }
  if ([...url.searchParams.keys()].length > 0) {
    throw new CliproxyConfigError(`api-call request carries no query string (${what})`);
  }
}

function assertNoKeyLeak(text: string, key: string, where: string): void {
  if (key && text.includes(key)) {
    throw new CliproxyBodyError(`refusing to propagate a value containing key material (${where})`);
  }
}

/**
 * Release an unread response body back to the transport pool. Node fetch
 * streams every body: a socket cannot be reused until the body is consumed
 * or cancelled, so every non-success branch below cancels before throwing.
 * Cancelling is local (no network round trip), so the stop-after-first-
 * auth-failure path stays immediate. Never throws.
 */
async function releaseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* Local cleanup only; never delays or masks the error path. */
  }
}

/**
 * Shared guarded fetch: the loopback/method/allow-list/redirect/timeout/cap/
 * no-leak rules both clients enforce. `headersFor` builds the auth headers
 * after origin + allow-list validation; `assertAllowed` is the client's own
 * pinned allow-list (management vs. client paths stay separated so neither
 * key can travel to the other's paths). `method` is `"GET"` for the pinned
 * reads or `"POST"` for the pinned `api-call` template POST (with `bodyText`
 * built internally from a frozen template — never from caller input); a
 * redirect hop re-sends the same method and body, and any hop whose target
 * leaves the pinned shape is refused.
 */
async function guardedJson(args: {
  startUrl: URL;
  baseOrigin: string;
  headersFor: () => Record<string, string>;
  keyForLeakCheck: string;
  fetchImpl: ManagementFetch;
  timeoutMs: number;
  maxBytes: number;
  assertAllowed: (url: URL, what: string) => void;
  method: "GET" | "POST";
  bodyText?: string;
  /**
   * Raw-text mode for credential-bearing downloads (the auth-file body):
   * return the capped body as a string instead of JSON-parsing it. The
   * caller extracts one field and drops the text immediately.
   */
  rawText?: boolean;
}): Promise<unknown> {
  let url = args.startUrl;
  for (let hop = 0; hop <= MANAGEMENT_MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { Accept: "application/json", ...args.headersFor() };
    let res: Response;
    try {
      res = await args.fetchImpl(url.toString(), {
        method: args.method,
        headers,
        body: args.method === "POST" ? (args.bodyText ?? "") : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(args.timeoutMs),
      });
    } catch (err) {
      // The transport reports only `err.name`, so keep the root cause visible
      // (e.g. `TimeoutError`, not `Error`); `instanceof` still matches.
      const label = err instanceof Error && err.name ? err.name : "fetch failed";
      const wrapped = new CliproxyNetworkError(`management ${args.method} ${url.pathname} failed: ${label}`);
      wrapped.name = label;
      throw wrapped;
    }
    if (res.status === 401 || res.status === 403) {
      await releaseBody(res);
      throw new CliproxyAuthError(res.status, url.pathname);
    }
    if (res.status === 404) {
      await releaseBody(res);
      throw new CliproxyNotFoundError(url.pathname);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        await releaseBody(res);
        throw new CliproxyRedirectError(`redirect without location on ${url.pathname}`);
      }
      let next: URL;
      try {
        next = new URL(location, url.toString());
      } catch {
        await releaseBody(res);
        throw new CliproxyRedirectError(`unparseable redirect location on ${url.pathname}`);
      }
      if (next.origin !== args.baseOrigin || !isLoopbackUrl(next.toString())) {
        await releaseBody(res);
        throw new CliproxyRedirectError(`redirect escapes the loopback origin; refusing to follow`);
      }
      try {
        args.assertAllowed(next, `redirect target ${next.pathname}`);
      } catch (err) {
        await releaseBody(res);
        throw new CliproxyRedirectError(
          `redirect target is outside the pinned allow-list; refusing to follow: ${err instanceof Error ? err.message : "blocked"}`,
        );
      }
      await releaseBody(res);
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      await releaseBody(res);
      throw new CliproxyNetworkError(`management ${args.method} ${url.pathname} returned HTTP ${res.status}`);
    }
    const text = await readCapped(res, url.pathname, args.maxBytes, args.method);
    assertNoKeyLeak(text, args.keyForLeakCheck, url.pathname);
    if (args.rawText === true) return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CliproxyBodyError(`management ${args.method} ${url.pathname} returned non-JSON`);
    }
  }
  throw new CliproxyRedirectError("too many redirects; refusing to follow");
}

async function readCapped(res: Response, path: string, maxBytes: number, method: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new CliproxyBodyError(`management ${method} ${path} exceeded the ${maxBytes} byte cap`);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new CliproxyBodyError(`management ${method} ${path} exceeded the ${maxBytes} byte cap`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class CliproxyManagementClient {
  private readonly baseUrl: string;
  private readonly keyHeader: string;
  private readonly key: string;
  private readonly fetchImpl: ManagementFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(opts: CliproxyClientOptions) {
    if (!isLoopbackUrl(opts.baseUrl)) {
      throw new CliproxyConfigError("CLIProxy base URL must be loopback.");
    }
    if (!opts.keyHeader) throw new CliproxyConfigError("Key header name is required.");
    if (!opts.key) throw new CliproxyConfigError("Resolved management key is required.");
    this.baseUrl = stripTrailingSlashes(opts.baseUrl);
    this.keyHeader = opts.keyHeader;
    this.key = opts.key;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? MANAGEMENT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? MANAGEMENT_MAX_BYTES;
  }

  private resolveTarget(path: string): URL {
    let url: URL;
    try {
      url = new URL(path, this.baseUrl);
    } catch {
      throw new CliproxyConfigError(`unparseable management path: ${path}`);
    }
    const origin = new URL(this.baseUrl).origin;
    if (url.origin !== origin || !isLoopbackUrl(url.toString())) {
      throw new CliproxyConfigError(`management target failed origin validation: ${path}`);
    }
    // Pinned allow-list + `api-call` ban, both on the decoded pathname so
    // percent-encoding cannot smuggle a blocked path past the check.
    assertAllowListed(url, path);
    return url;
  }

  /** GET one pinned path. Returns parsed JSON (object or array). */
  async getJson(path: string): Promise<unknown> {
    const url = this.resolveTarget(path);
    const keyHeader = this.keyHeader;
    const key = this.key;
    return guardedJson({
      startUrl: url,
      baseOrigin: new URL(this.baseUrl).origin,
      // Attach the key header only after origin validation above.
      headersFor: () => ({ [keyHeader]: key }),
      keyForLeakCheck: key,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      assertAllowed: assertAllowListed,
      method: "GET",
    });
  }

  getAuthFiles(): Promise<unknown> {
    return this.getJson(AUTH_FILES_PATH);
  }

  /**
   * GET one auth file's live served set. The name is validated to a single
   * safe value before any network happens; 401/403 spends the strike budget
   * like every other management GET, while 404 (`CliproxyNotFoundError`) is
   * the caller's cue to degrade to the `model_quotas` heuristic.
   */
  async getAuthFileModels(name: string): Promise<unknown> {
    // Validated single safe value: the substituted path always matches the
    // pinned shape. Anything else rejects before any network happens.
    // (`async` so the validation throw surfaces as a rejection.)
    return this.getJson(authFileModelsPath(name));
  }

  /**
   * GET one auth file's raw bytes for Meta quota (`readDcaTokenFromAuthFile`
   * extracts the `dca_token`; stock serves the stored file verbatim). The
   * response is credential-bearing, so this returns the raw text and the
   * caller extracts one field and drops it immediately — nothing here parses
   * it into a retained object, and no error message quotes it. 401/403 still
   * throws `CliproxyAuthError` (the key itself was rejected); 404 throws
   * `CliproxyNotFoundError` (the file vanished between listing and download).
   */
  async getAuthFileText(name: string): Promise<string> {
    // Validated single safe value (plus the stock `.json` suffix rule): the
    // substituted path always matches the pinned shape. Anything else
    // rejects before any network happens. (`async` so the validation throw
    // surfaces as a rejection.)
    const url = this.resolveTarget(authFileDownloadPath(name));
    const keyHeader = this.keyHeader;
    const key = this.key;
    return (await guardedJson({
      startUrl: url,
      baseOrigin: new URL(this.baseUrl).origin,
      // Attach the key header only after origin validation above.
      headersFor: () => ({ [keyHeader]: key }),
      keyForLeakCheck: key,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      assertAllowed: assertAllowListed,
      method: "GET",
      rawText: true,
    })) as string;
  }

  /**
   * GET the per-provider request counts (`api-key` auths only). No query
   * string: the pinned shape above refuses parameters before any network
   * happens. Best-effort like every quota read — the caller decides auth
   * handling (401/403 on this endpoint warns and skips without spending
   * strikes; see the sync's fail-closed request-count path).
   */
  async getApiKeyUsage(): Promise<unknown> {
    return this.getJson(API_KEY_USAGE_PATH);
  }

  /**
   * GET one plugin's quota for one credential (`?auth_index=…`, required
   * since CLIProxy v8.0.49). Omit `authIndex` only for the legacy
   * provider-level shape on older builds. Best-effort like every quota read:
   * 404/5xx/network failures warn per provider or per file and never spend
   * strikes; 401/403 still stops the run (the key itself was rejected).
   */
  async getPluginQuota(pluginId: string, authIndex?: string | null): Promise<unknown> {
    // Validated single segment + single safe query value: the substituted
    // path always matches the pinned shape. Anything else rejects before any
    // network happens. (`async` so the validation throw surfaces as a rejection.)
    return this.getJson(pluginQuotaPath(pluginId, authIndex));
  }

  /**
   * POST one pinned `api-call` template for one credential.
   *
   * The caller names a template KEY only; the upstream method, URL, headers
   * and body come from the frozen template, so this method structurally cannot
   * send an arbitrary upstream request. The only per-account variables are
   * `authIndex` (validated before any network happens) and, for the
   * Antigravity quota templates, `projectId` — validated by
   * `isSafeApiCallProjectId` and injected via `JSON.stringify`, so it can
   * never break out of its JSON string. The template's `$TOKEN$` placeholders
   * are substituted with the stored credential server-side by CLIProxy — the
   * plugin never sees them.
   *
   * Transport errors keep the GET semantics: 401/403 spends the strike budget
   * (the key itself was rejected), 404/5xx/network failures are the caller's
   * cue to warn per file and stay quota-blind. The UPSTREAM status travels
   * inside the returned envelope (`statusCode`) and never throws here: a
   * provider-side 4xx/5xx is a per-file warning (plus per-account backoff for
   * upstream 401/403, owned by the caller), not a sync failure.
   */
  async postApiCall(
    templateKey: string,
    authIndex: string,
    opts?: { projectId?: string },
  ): Promise<ApiCallResult> {
    const template = apiCallTemplate(templateKey);
    if (!isSafeAuthIndex(authIndex)) {
      throw new CliproxyConfigError(`refusing an api-call request with an untrusted auth index`);
    }
    let data = template.data;
    if (template.requiresProjectId) {
      const projectId = opts?.projectId;
      if (typeof projectId !== "string" || !isSafeApiCallProjectId(projectId)) {
        throw new CliproxyConfigError(
          `refusing an api-call quota request with a missing or untrusted project id`,
        );
      }
      data = JSON.stringify({ project: projectId });
    } else if (opts?.projectId !== undefined) {
      throw new CliproxyConfigError(
        `refusing an api-call request that passes a project id to a non-quota template`,
      );
    }
    const url = this.resolveApiCallTarget();
    const requestBody = JSON.stringify({
      auth_index: authIndex,
      method: template.method,
      url: template.url,
      header: template.headers,
      data,
    });
    const keyHeader = this.keyHeader;
    const key = this.key;
    const raw = await guardedJson({
      startUrl: url,
      baseOrigin: new URL(this.baseUrl).origin,
      // Attach the key header only after origin validation above.
      headersFor: () => ({ [keyHeader]: key, "Content-Type": "application/json" }),
      keyForLeakCheck: key,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      assertAllowed: assertApiCallAllowListed,
      method: "POST",
      bodyText: requestBody,
    });
    return parseApiCallEnvelope(raw);
  }

  /**
   * POST the Meta Muse-key quota read for one credential: `auth_index` plus a
   * literal `Authorization: Bearer <dca>` header carrying the account's
   * downloaded `dca_token` (see `readDcaTokenFromAuthFile`). Every other field
   * is a frozen literal copied from the panel
   * (`src/features/quota/providers/meta/requests.ts`): `POST` to
   * `META_MUSE_CODE_KEY_URL` with `Accept` / `Content-Type` /
   * `x-api-version: 1.0.0` headers and `'{}'` data.
   *
   * Stock `api_tools.go` passes headers without `$TOKEN$` through untouched,
   * so the literal bearer reaches the provider exactly as the panel sends it
   * — this is the only `api-call` shape that can authenticate Meta (server
   * side `$TOKEN$` substitution skips `dca:` tokens). The token lives in this
   * call's request body only: it is validated before any network happens,
   * never logged (error messages are pathname-only), scrubbed out of any
   * error that quotes it (defense-in-depth — the transport never does), and
   * the caller drops its own copy right after this resolves.
   *
   * Transport semantics match `postApiCall`: 401/403 spends the strike budget
   * (the key itself was rejected), 404/5xx/network failures are the caller's
   * cue to warn per file and stay quota-blind. The UPSTREAM status travels
   * inside the returned envelope and never throws here.
   */
  async postMetaMuseCodeKey(authIndex: string, dcaToken: string): Promise<ApiCallResult> {
    if (!isSafeAuthIndex(authIndex)) {
      throw new CliproxyConfigError(`refusing a Meta key request with an untrusted auth index`);
    }
    if (!DCA_TOKEN_PATTERN.test(dcaToken) || dcaToken.length > DCA_TOKEN_MAX_LENGTH) {
      throw new CliproxyConfigError(`refusing a Meta key request with an unusable dca token`);
    }
    const url = this.resolveApiCallTarget();
    const requestBody = JSON.stringify({
      auth_index: authIndex,
      method: "POST",
      url: META_MUSE_CODE_KEY_URL,
      header: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${dcaToken}`,
        "x-api-version": "1.0.0",
      },
      data: "{}",
    });
    const keyHeader = this.keyHeader;
    const key = this.key;
    let raw: unknown;
    try {
      raw = await guardedJson({
        startUrl: url,
        baseOrigin: new URL(this.baseUrl).origin,
        // Attach the key header only after origin validation above.
        headersFor: () => ({ [keyHeader]: key, "Content-Type": "application/json" }),
        keyForLeakCheck: key,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
        assertAllowed: assertApiCallAllowListed,
        method: "POST",
        bodyText: requestBody,
      });
    } catch (err) {
      // The transport never quotes the request body (messages are
      // pathname-only), so this scrub is defense-in-depth only — but a
      // future transport change must not be the day a bearer reaches a log.
      if (err instanceof Error && dcaToken && err.message.includes(dcaToken)) {
        err.message = err.message.split(dcaToken).join("[redacted-dca-token]");
      }
      throw err;
    }
    return parseApiCallEnvelope(raw);
  }

  private resolveApiCallTarget(): URL {
    let url: URL;
    try {
      url = new URL(API_CALL_PATH, this.baseUrl);
    } catch {
      throw new CliproxyConfigError(`unparseable management path: ${API_CALL_PATH}`);
    }
    const origin = new URL(this.baseUrl).origin;
    if (url.origin !== origin || !isLoopbackUrl(url.toString())) {
      throw new CliproxyConfigError(`management target failed origin validation: ${API_CALL_PATH}`);
    }
    // Pinned POST allow-list: exactly the api-call path, no query string.
    assertApiCallAllowListed(url, API_CALL_PATH);
    return url;
  }
}

/**
 * One upstream answer behind `POST /v0/management/api-call`: the upstream
 * HTTP status plus the parsed upstream body (JSON when the body parses,
 * otherwise the raw string, otherwise null for an empty body). Response
 * headers are deliberately dropped — they carry no quota signal the parsers
 * need.
 */
export interface ApiCallResult {
  statusCode: number;
  body: unknown;
}

/**
 * Validate the management `api-call` envelope (`{status_code, header, body}`
 * per `api_tools.go: apiCallResponse`). Anything else is a body error — never
 * quota data. Upstream bodies may carry account identifiers, so this returns
 * the body for field-whitelisted parsers only; nothing here logs or persists.
 */
function parseApiCallEnvelope(raw: unknown): ApiCallResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CliproxyBodyError("management POST /v0/management/api-call returned a non-object envelope");
  }
  const record = raw as Record<string, unknown>;
  const statusCode = record.status_code ?? record.statusCode;
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) {
    throw new CliproxyBodyError("management POST /v0/management/api-call returned no upstream status");
  }
  const bodyRaw = record.body ?? record.bodyText ?? null;
  let body: unknown = null;
  if (typeof bodyRaw === "string") {
    const trimmed = bodyRaw.trim();
    if (trimmed) {
      try {
        body = JSON.parse(trimmed) as unknown;
      } catch {
        body = bodyRaw;
      }
    }
  } else if (bodyRaw !== null && bodyRaw !== undefined) {
    body = bodyRaw;
  }
  return { statusCode, body };
}

export interface CliproxyClientApiOptions {
  baseUrl: string;
  /** Resolved client (non-management) API key. In memory only; never logged. */
  key: string;
  fetchImpl?: ManagementFetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * CLIProxy client-API reader for the served model list (`GET /v1/models`).
 *
 * This path is NOT the management API, so the management safeguards' hard
 * rule allows it — but it still enforces every guarded-fetch rule (loopback
 * base URL re-validated per call, Bearer key attached only after origin
 * validation, pinned `/v1/models` allow-list, `api-call` ban, manual
 * redirects with re-validation, timeouts, size caps, no key leaks). The
 * management key can never travel here and the client key can never travel
 * to the management paths: the two allow-lists are disjoint by construction.
 */
export class CliproxyClientApiClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly fetchImpl: ManagementFetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(opts: CliproxyClientApiOptions) {
    if (!isLoopbackUrl(opts.baseUrl)) {
      throw new CliproxyConfigError("CLIProxy base URL must be loopback.");
    }
    if (!opts.key) throw new CliproxyConfigError("Resolved client API key is required.");
    this.baseUrl = stripTrailingSlashes(opts.baseUrl);
    this.key = opts.key;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? MANAGEMENT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? MANAGEMENT_MAX_BYTES;
  }

  private resolveTarget(path: string): URL {
    let url: URL;
    try {
      url = new URL(path, this.baseUrl);
    } catch {
      throw new CliproxyConfigError(`unparseable client path: ${path}`);
    }
    const origin = new URL(this.baseUrl).origin;
    if (url.origin !== origin || !isLoopbackUrl(url.toString())) {
      throw new CliproxyConfigError(`client target failed origin validation: ${path}`);
    }
    assertModelsAllowListed(url, path);
    return url;
  }

  /** GET the pinned served-model list. Returns parsed JSON (object or array). */
  async getModels(): Promise<unknown> {
    const url = this.resolveTarget(MODELS_PATH);
    const key = this.key;
    return guardedJson({
      startUrl: url,
      baseOrigin: new URL(this.baseUrl).origin,
      // OpenAI-compatible Bearer auth, attached only after origin validation.
      headersFor: () => ({ Authorization: `Bearer ${key}` }),
      keyForLeakCheck: key,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      assertAllowed: assertModelsAllowListed,
      method: "GET",
    });
  }
}
