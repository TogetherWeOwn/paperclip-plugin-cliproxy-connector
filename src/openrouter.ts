/**
 * OpenRouter credits read (provider-side spend, read-only).
 *
 * One worker-side GET per sync to the fixed credits endpoint, authenticated
 * with the dedicated `openRouterSecretRef` key. Defence in depth, mirroring
 * the management client's rules where they apply:
 * - the URL is a frozen module constant, never config-supplied (no
 *   SSRF-by-config: the operator cannot steer the `Authorization` header);
 * - the secret is resolved per run and kept in memory only, never persisted;
 * - only `{provider, totalCredits, totalUsage, fetchedAt}` is stored — the
 *   raw payload is never persisted, logged, or surfaced;
 * - the response is size-capped and schema-checked before storage;
 * - failures are soft: the caller keeps the last-known snapshot and records
 *   a scrubbed note (never a throw that fails the quota sync).
 *
 * Deploy step (not code): the host `http.outbound` egress policy must allow
 * `openrouter.ai`, verified on staging before relying on this read.
 */

import type { ProviderSpend } from "./types.js";

/**
 * Fixed credits endpoint. A constant, not a config value: the `Authorization`
 * header is sent only here, so no config edit can redirect the key.
 */
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

/** Fixed host the OpenRouter secret may travel to (constant, see above). */
export const OPENROUTER_HOST = "openrouter.ai";

/** Response cap: the credits payload is a few hundred bytes; anything larger is hostile. */
export const OPENROUTER_MAX_BYTES = 64 * 1024;

export class OpenRouterBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterBodyError";
  }
}

/** Minimal `fetch` surface this module needs (host `ctx.http.fetch` in the worker). */
export type OpenRouterFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Validate the credits payload shape (`{data: {total_credits, total_usage}}`)
 * and project it to the stored fields. Anything else is a body error — never
 * spend data. Numbers must be finite and non-negative; the endpoint reports
 * credit amounts, so negatives reject rather than flowing into a "remaining"
 * figure on the page.
 */
export function parseOpenRouterCredits(raw: unknown, fetchedAt: string): ProviderSpend {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OpenRouterBodyError("OpenRouter credits payload is not an object.");
  }
  const data = (raw as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new OpenRouterBodyError("OpenRouter credits payload carries no data object.");
  }
  const record = data as Record<string, unknown>;
  const totalCredits = record.total_credits ?? record.totalCredits;
  const totalUsage = record.total_usage ?? record.totalUsage;
  for (const [name, value] of [
    ["total_credits", totalCredits],
    ["total_usage", totalUsage],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new OpenRouterBodyError(`OpenRouter credits payload carries no usable ${name}.`);
    }
  }
  return {
    provider: "openrouter",
    totalCredits: totalCredits as number,
    totalUsage: totalUsage as number,
    fetchedAt,
  };
}

async function readCapped(res: Response): Promise<string> {
  const text = await res.text();
  if (text.length > OPENROUTER_MAX_BYTES) {
    throw new OpenRouterBodyError(
      `OpenRouter credits response exceeded the ${OPENROUTER_MAX_BYTES} byte cap.`,
    );
  }
  return text;
}

/**
 * Fetch and parse the credits snapshot. The secret travels only as the
 * `Authorization` header to the fixed endpoint constant above; it is never
 * logged, persisted, or placed in error text (callers scrub messages before
 * storage as defense-in-depth, the same way management warnings are
 * scrubbed — error paths here never interpolate the secret).
 */
export async function fetchOpenRouterCredits(args: {
  httpFetch: OpenRouterFetch;
  secret: string;
  fetchedAt: string;
}): Promise<ProviderSpend> {
  if (!args.secret) {
    throw new OpenRouterBodyError("OpenRouter secret resolved empty; refusing to probe without a key.");
  }
  let res: Response;
  try {
    res = await args.httpFetch(OPENROUTER_CREDITS_URL, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${args.secret}` },
      redirect: "manual",
    });
  } catch (err) {
    const label = err instanceof Error && err.name ? err.name : "fetch failed";
    throw new OpenRouterBodyError(`OpenRouter credits fetch failed: ${label}.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new OpenRouterBodyError(
      `OpenRouter rejected the credits key (HTTP ${res.status}); rotate the bound secret.`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new OpenRouterBodyError(`OpenRouter credits returned HTTP ${res.status}.`);
  }
  const text = await readCapped(res);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new OpenRouterBodyError("OpenRouter credits returned non-JSON.");
  }
  return parseOpenRouterCredits(raw, args.fetchedAt);
}
