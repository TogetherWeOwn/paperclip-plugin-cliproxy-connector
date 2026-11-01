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

import { isLoopbackUrl } from "./config.js";

export const MANAGEMENT_TIMEOUT_MS = 15_000;
export const MANAGEMENT_MAX_BYTES = 2 * 1024 * 1024;
export const MANAGEMENT_MAX_REDIRECTS = 2;

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

export interface ManagementPaths {
  authFilesPath: string;
  pluginQuotaPathTemplate: string;
  modelsPath: string;
}

/** The client only ever GETs string URLs; keep the type structural. */
export type ManagementFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CliproxyClientOptions {
  baseUrl: string;
  keyHeader: string;
  /** Resolved management key. In memory only; never logged or persisted. */
  key: string;
  paths: ManagementPaths;
  fetchImpl?: ManagementFetch;
  timeoutMs?: number;
  maxBytes?: number;
}

function assertNoKeyLeak(text: string, key: string, where: string): void {
  if (key && text.includes(key)) {
    throw new CliproxyBodyError(`refusing to propagate a value containing key material (${where})`);
  }
}

export class CliproxyManagementClient {
  private readonly baseUrl: string;
  private readonly keyHeader: string;
  private readonly key: string;
  private readonly paths: ManagementPaths;
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
    this.paths = opts.paths;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? MANAGEMENT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? MANAGEMENT_MAX_BYTES;
  }

  /** Expanded allow-list. Every entry is GET-only. */
  private allowedPaths(extraPluginIds: string[] = []): string[] {
    const paths = [this.paths.authFilesPath, this.paths.modelsPath];
    for (const id of extraPluginIds) {
      paths.push(this.paths.pluginQuotaPathTemplate.replace("{pluginId}", id));
    }
    return paths;
  }

  private resolveTarget(path: string, extraPluginIds: string[] = []): URL {
    const allow = this.allowedPaths(extraPluginIds);
    if (!allow.includes(path)) {
      throw new CliproxyConfigError(`path is outside the GET allow-list: ${path}`);
    }
    if (path.includes("api-call")) {
      throw new CliproxyConfigError("`api-call` is excluded from the allow-list and can never be called.");
    }
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
    return url;
  }

  /** GET one allow-listed path. Returns parsed JSON (object or array). */
  async getJson(path: string, extraPluginIds: string[] = []): Promise<unknown> {
    let url = this.resolveTarget(path, extraPluginIds);
    for (let hop = 0; hop <= MANAGEMENT_MAX_REDIRECTS; hop++) {
      // Attach the key header only after origin validation above.
      const headers: Record<string, string> = { Accept: "application/json" };
      headers[this.keyHeader] = this.key;
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
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
        const origin = new URL(this.baseUrl).origin;
        if (next.origin !== origin || !isLoopbackUrl(next.toString())) {
          throw new CliproxyRedirectError(`redirect escapes the loopback origin; refusing to follow`);
        }
        if (!this.allowedPaths(extraPluginIds).includes(next.pathname)) {
          throw new CliproxyRedirectError(`redirect target is outside the GET allow-list; refusing to follow`);
        }
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new CliproxyNetworkError(`management GET ${url.pathname} returned HTTP ${res.status}`);
      }
      const text = await this.readCapped(res, url.pathname);
      assertNoKeyLeak(text, this.key, url.pathname);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new CliproxyBodyError(`management GET ${url.pathname} returned non-JSON`);
      }
    }
    throw new CliproxyRedirectError("too many redirects; refusing to follow");
  }

  private async readCapped(res: Response, path: string): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (text.length > this.maxBytes) {
        throw new CliproxyBodyError(`management GET ${path} exceeded the ${this.maxBytes} byte cap`);
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
        if (total > this.maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new CliproxyBodyError(`management GET ${path} exceeded the ${this.maxBytes} byte cap`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  getAuthFiles(): Promise<unknown> {
    return this.getJson(this.paths.authFilesPath);
  }

  getPluginQuota(pluginId: string): Promise<unknown> {
    const path = this.paths.pluginQuotaPathTemplate.replace("{pluginId}", pluginId);
    return this.getJson(path, [pluginId]);
  }

  getModels(): Promise<unknown> {
    return this.getJson(this.paths.modelsPath);
  }
}
