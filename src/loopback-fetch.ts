/**
 * Worker-local loopback transport for the CLIProxy management/client GETs.
 *
 * Stock Paperclip (>= 2026.1023.0) runs every `ctx.http.fetch` through the
 * host SSRF guard, which refuses loopback — but this plugin requires a
 * loopback `cliproxyBaseUrl`, so the host client can never reach it
 * (`cliproxy-resync` fails with `JsonRpcCallError`). The SDK explicitly
 * allows plugins to use standard Node `fetch` directly; this module is that
 * escape hatch, guarded so it can never become an open proxy:
 * - loopback-only base URL at construction, re-validated per request
 * - canonical origin match (host:port from config) per request — a different
 *   port or a non-loopback host is refused without touching the network
 * - `localhost` is rewritten to `127.0.0.1` before validation and before the
 *   request leaves, so the OS resolver can never steer a key-bearing request
 * - GET only; `redirect: "manual"` is forced so a redirect is never followed
 *   automatically (the management client re-validates every hop itself)
 * - caller timeout via `AbortSignal` (default 15 s)
 *
 * The pinned GET allow-list, response size caps, key handling and the strike
 * budget stay in `cliproxy.ts` / `sync.ts` — this module is only the
 * transport, used for the configured loopback origin and nothing else.
 */

import {
  CliproxyConfigError,
  CliproxyNetworkError,
  MANAGEMENT_TIMEOUT_MS,
  type ManagementFetch,
} from "./cliproxy.js";
import { isLoopbackUrl } from "./config.js";

export interface LoopbackFetchOptions {
  /**
   * Override the underlying fetch (tests). Defaults to Node's global fetch.
   * Typed as `ManagementFetch` (string URLs only): the transport always calls
   * it with a validated string URL, never a `Request` object.
   */
  fetchImpl?: ManagementFetch;
  timeoutMs?: number;
}

/**
 * Canonical loopback form: `localhost` is rewritten to `127.0.0.1` so the
 * transport never depends on the OS resolver for the loopback name — a
 * misconfigured resolver (or a hostile one) must not be able to steer a
 * key-bearing request off the machine. Literal `127.0.0.1` / `::1` pass
 * through unchanged, so no DNS lookup is involved either way.
 */
function canonicalLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliproxyConfigError("loopback transport refuses an unparseable URL.");
  }
  if (url.hostname.toLowerCase() === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url;
}

/**
 * Build the guarded loopback transport for one configured CLIProxy base URL.
 * Throws `CliproxyConfigError` for a non-loopback base URL before any network
 * happens (company config validation already rejects those, so this is belt
 * and braces at the transport layer).
 */
export function createLoopbackFetch(baseUrl: string, opts: LoopbackFetchOptions = {}): ManagementFetch {
  const base = canonicalLoopbackUrl(baseUrl);
  if (!isLoopbackUrl(base.toString())) {
    throw new CliproxyConfigError(`loopback transport refuses a non-loopback base URL: ${baseUrl}`);
  }
  const baseOrigin = base.origin;
  const underlying = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? MANAGEMENT_TIMEOUT_MS;
  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method !== undefined && init.method.toUpperCase() !== "GET") {
      throw new CliproxyConfigError("loopback transport allows GET only; refusing to send another method.");
    }
    const url = canonicalLoopbackUrl(input);
    // Canonical origin (host:port from config), and loopback: a request to
    // any other host — loopback-spelled or not — never leaves this function.
    if (url.origin !== baseOrigin || !isLoopbackUrl(url.toString())) {
      throw new CliproxyConfigError("loopback transport refuses a target outside the configured loopback origin.");
    }
    try {
      return await underlying(url.toString(), {
        ...init,
        method: "GET",
        // Never follow automatically: the management client surfaces the 3xx
        // and re-validates (same-origin loopback, pinned allow-list) per hop.
        redirect: "manual",
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CliproxyNetworkError(
        `loopback GET ${url.pathname} failed: ${err instanceof Error ? err.name : "fetch failed"}`,
      );
    }
  };
}
