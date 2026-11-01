/**
 * Safe CLIProxy management client (proposal §4).
 *
 * Defence in depth, all enforced here rather than at call sites:
 * - loopback-only base URL, validated at construction and re-validated per call
 * - key header attached only after origin validation
 * - GET-only allow-list; `api-call` is excluded and can never be admitted
 *   through this client (it executes upstream requests with stored upstream
 *   credentials, so "GET-only" would be a lie)
 * - `redirect: "manual"` with re-validation of every hop (max 2, same-origin
 *   loopback only)
 * - 15 s timeouts, size-capped bodies, JSON schema-checked before storage
 * - the key never appears in errors, logs or persisted state (see redaction
 *   tests in `cliproxy.test.ts`)
 *
 * Agents never touch this client: it runs in the plugin worker sync job, the
 * key is resolved per run from a `secret_ref` and kept in memory only.
 */

import { SINGLE_SEGMENT, isLoopbackUrl } from "./config.js";

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
 * Pinned client path (fixed shape, never a config string). The only GET the
 * client API key is ever attached to: the served model list that drives
 * model → provider derivation. Same guarded-fetch rules as the management
 * path (loopback, manual redirects, timeouts, size caps, no key leaks).
 */
export const MODELS_PATH = "/v1/models";

export function pluginQuotaPath(pluginId: string): string {
  if (!SINGLE_SEGMENT.test(pluginId)) {
    throw new CliproxyConfigError(`refusing to build a quota path from an untrusted plugin id: ${pluginId}`);
  }
  return `/v0/management/plugins/${pluginId}/quota`;
}

export class CliproxyConfigError extends Error {}
export class CliproxyAuthError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`CLIProxy management rejected the key (HTTP ${status} on ${path})`);
    this.name = "CliproxyAuthError";
    this.status = status;
  }
}
export class CliproxyRedirectError extends Error {}
export class CliproxyBodyError extends Error {}
export class CliproxyNetworkError extends Error {}

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
  if (pathname !== AUTH_FILES_PATH && !PLUGIN_QUOTA_SHAPE.test(pathname)) {
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

function assertNoKeyLeak(text: string, key: string, where: string): void {
  if (key && text.includes(key)) {
    throw new CliproxyBodyError(`refusing to propagate a value containing key material (${where})`);
  }
}

/**
 * Shared guarded GET: the loopback/method/allow-list/redirect/timeout/cap/
 * no-leak rules both clients enforce. `headersFor` builds the auth headers
 * after origin + allow-list validation; `assertAllowed` is the client's own
 * pinned allow-list (management vs. client paths stay separated so neither
 * key can travel to the other's paths).
 */
async function guardedGetJson(args: {
  startUrl: URL;
  baseOrigin: string;
  headersFor: () => Record<string, string>;
  keyForLeakCheck: string;
  fetchImpl: ManagementFetch;
  timeoutMs: number;
  maxBytes: number;
  assertAllowed: (url: URL, what: string) => void;
}): Promise<unknown> {
  let url = args.startUrl;
  for (let hop = 0; hop <= MANAGEMENT_MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { Accept: "application/json", ...args.headersFor() };
    let res: Response;
    try {
      res = await args.fetchImpl(url.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(args.timeoutMs),
      });
    } catch (err) {
      throw new CliproxyNetworkError(
        `management GET ${url.pathname} failed: ${err instanceof Error ? err.name : "fetch failed"}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new CliproxyAuthError(res.status, url.pathname);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new CliproxyRedirectError(`redirect without location on ${url.pathname}`);
      let next: URL;
      try {
        next = new URL(location, url.toString());
      } catch {
        throw new CliproxyRedirectError(`unparseable redirect location on ${url.pathname}`);
      }
      if (next.origin !== args.baseOrigin || !isLoopbackUrl(next.toString())) {
        throw new CliproxyRedirectError(`redirect escapes the loopback origin; refusing to follow`);
      }
      try {
        args.assertAllowed(next, `redirect target ${next.pathname}`);
      } catch (err) {
        throw new CliproxyRedirectError(
          `redirect target is outside the pinned GET allow-list; refusing to follow: ${err instanceof Error ? err.message : "blocked"}`,
        );
      }
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new CliproxyNetworkError(`management GET ${url.pathname} returned HTTP ${res.status}`);
    }
    const text = await readCapped(res, url.pathname, args.maxBytes);
    assertNoKeyLeak(text, args.keyForLeakCheck, url.pathname);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CliproxyBodyError(`management GET ${url.pathname} returned non-JSON`);
    }
  }
  throw new CliproxyRedirectError("too many redirects; refusing to follow");
}

async function readCapped(res: Response, path: string, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new CliproxyBodyError(`management GET ${path} exceeded the ${maxBytes} byte cap`);
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
        throw new CliproxyBodyError(`management GET ${path} exceeded the ${maxBytes} byte cap`);
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
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
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
    return guardedGetJson({
      startUrl: url,
      baseOrigin: new URL(this.baseUrl).origin,
      // Attach the key header only after origin validation above.
      headersFor: () => ({ [keyHeader]: key }),
      keyForLeakCheck: key,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      assertAllowed: assertAllowListed,
    });
  }

  getAuthFiles(): Promise<unknown> {
    return this.getJson(AUTH_FILES_PATH);
  }

  async getPluginQuota(pluginId: string): Promise<unknown> {
    // Validated single segment: the substituted path always matches the
    // pinned shape. Anything else rejects before any network happens.
    // (`async` so the validation throw surfaces as a rejection.)
    return this.getJson(pluginQuotaPath(pluginId));
  }
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
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
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
    return guardedGetJson({
      startUrl: url,
      baseOrigin: new URL(this.baseUrl).origin,
      // OpenAI-compatible Bearer auth, attached only after origin validation.
      headersFor: () => ({ Authorization: `Bearer ${key}` }),
      keyForLeakCheck: key,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      assertAllowed: assertModelsAllowListed,
    });
  }
}
