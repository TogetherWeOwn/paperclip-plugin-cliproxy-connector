/**
 * Model → provider derivation from live CLIProxy state (TWO-679, 09:16Z owner
 * correction: stock CLIProxy, no required aliases or prefixes).
 *
 * At each sync the plugin fetches the served model list (`GET /v1/models`,
 * with the *client* API key — never the management key) and intersects it
 * with the auth-file list. A connection's model list is its provider's stock
 * ids: bare for Claude, Codex, Antigravity and Meta; `devin/…` for Devin;
 * fixed plugin namespaces (`synthetic/…`, `nvidia/…`, `cloudflare/…`,
 * `zai/…`, `opencode-go/…`); `opencode-zen-free` (openai-compat) is bare
 * unless its entry sets the stock `prefix` field.
 *
 * Attribution rules (no hard-coded id lists):
 * - Namespaced ids (`ns/rest`) attribute by namespace through
 *   `normalizeProvider(ns)`. The namespace wins over `/v1/models`
 *   `owned_by`: Devin reports `owned_by: anthropic` for
 *   `devin/claude-…`, but the quota — and the model — is Devin's.
 * - Bare ids attribute by per-provider `model_quotas` evidence from
 *   `auth-files` (grouped by auth-file `provider`, never by `owned_by`),
 *   falling back to `owned_by` when no provider reports the id (this covers
 *   quota-blind providers such as Meta, whose accounts carry no per-model
 *   state but whose served ids still carry an honest `owned_by`).
 * - A bare id attributable to more than one provider (the likely source is
 *   `opencode-zen-free`'s bare ids) is an overlap: it is flagged, and it is
 *   not counted as any provider's proven model. The plugin never requires or
 *   suggests CLIProxy config; the openai-compat `prefix` field is only an
 *   optional operator-side fix, mentioned in the README.
 */

import { normalizeProvider } from "./parsers.js";

export interface ServedModel {
  /** Served id, lowercased for matching. */
  id: string;
  /** Raw `owned_by` value, or null when absent. Never used for quota grouping. */
  ownedBy: string | null;
}

export interface ModelOverlap {
  /** Served id claimed by more than one provider (lowercased). */
  id: string;
  /** Sorted provider words that all plausibly serve it. */
  providers: string[];
}

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

/**
 * Parse a `/v1/models` payload. Shape-tolerant: accepts the OpenAI list shape
 * (`{data: [...]}`), a `{models: [...]}` wrapper, or a bare array. Entries
 * accept `{id, owned_by|ownedBy|owner}` objects or plain id strings. Entries
 * without a usable id are skipped with a warning — never trusted.
 */
export function parseModelsPayload(payload: unknown): { models: ServedModel[]; warnings: string[] } {
  const warnings: string[] = [];
  const models: ServedModel[] = [];
  const root = asObj(payload);
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : root
      ? (["data", "models", "items", "results"]
          .map((k) => (root as Json)[k])
          .find((v) => Array.isArray(v)) as unknown[]) ?? []
      : [];
  if (entries.length === 0) {
    warnings.push("models payload holds no entries; no provider has proven models this run.");
    return { models, warnings };
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const o = asObj(e);
    const rawId = typeof e === "string" ? e : o ? (o.id ?? o.ID ?? o.name ?? null) : null;
    if (typeof rawId !== "string" || !rawId.trim()) {
      warnings.push("skipping a /v1/models entry without a usable id.");
      continue;
    }
    const id = rawId.trim().toLowerCase();
    if (seen.has(id)) continue; // served twice (aliases) — keep the first
    seen.add(id);
    const ownedRaw = o ? (o.owned_by ?? o.ownedBy ?? o.owner ?? null) : null;
    models.push({ id, ownedBy: typeof ownedRaw === "string" && ownedRaw.trim() ? ownedRaw.trim() : null });
  }
  return { models, warnings };
}

/** Namespace prefix of `ns/rest`, or null for bare ids. */
export function namespaceOfModelId(id: string): string | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return id.slice(0, slash);
}

/**
 * Collect per-provider observed model keys from parsed auth-file rows: every
 * `model_quotas` key (already lowercased by the parser), grouped by the
 * row's auth-file provider. Account-level windows (`models == null`) are not
 * model evidence.
 */
export function observedModelKeysByProvider(
  rows: Array<{ provider: string; limits: Array<{ models?: string[] | null }> }>,
): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const row of rows) {
    const provider = row.provider.toLowerCase();
    for (const limit of row.limits) {
      if (!limit.models || limit.models.length === 0) continue;
      let set = byProvider.get(provider);
      if (!set) {
        set = new Set<string>();
        byProvider.set(provider, set);
      }
      for (const m of limit.models) set.add(m.toLowerCase());
    }
  }
  return byProvider;
}

/**
 * Derive each provider's proven served ids plus the overlap list.
 *
 * - Namespaced ids attribute by namespace (namespace wins over `owned_by`).
 *   A namespace that names no known provider is unattributed with a warning.
 * - Bare ids attribute to their single claimant (via `model_quotas`
 *   evidence), else to their `owned_by` provider when that provider is in
 *   scope, else unattributed. Two or more attributing providers is an
 *   overlap: flagged, and proven for nobody.
 */
export function deriveProviderModels(
  served: ServedModel[],
  opts: {
    /** Lowercase provider words in scope (discovered + configured). */
    authProviders: string[];
    /** Per-provider observed `model_quotas` keys (lowercased). */
    observedKeysByProvider: Map<string, Set<string>>;
  },
): { providerModels: Record<string, string[]>; overlaps: ModelOverlap[]; warnings: string[] } {
  const warnings: string[] = [];
  const overlaps: ModelOverlap[] = [];
  const proven = new Map<string, string[]>();
  const inScope = new Set(opts.authProviders.map((p) => p.toLowerCase()));
  const give = (provider: string, id: string) => {
    const list = proven.get(provider);
    if (list) {
      if (!list.includes(id)) list.push(id);
    } else {
      proven.set(provider, [id]);
    }
  };

  for (const { id, ownedBy } of served) {
    const ns = namespaceOfModelId(id);
    if (ns !== null) {
      // Namespace-first: `owned_by` never overrides it (Devin case).
      const provider = normalizeProvider(ns);
      if (provider === "unknown-provider") {
        warnings.push(
          `model ${JSON.stringify(id)} names an unknown namespace ${JSON.stringify(ns)}; not counted as any provider's proven model.`,
        );
        continue;
      }
      give(provider, id);
      continue;
    }
    const claimants = [...inScope].filter((p) => opts.observedKeysByProvider.get(p)?.has(id) ?? false).sort();
    const owned = ownedBy ? normalizeProvider(ownedBy) : "unknown-provider";
    const ownedInScope = owned !== "unknown-provider" && inScope.has(owned) ? owned : null;
    const parties = [...new Set([...claimants, ...(ownedInScope ? [ownedInScope] : [])])].sort();
    if (parties.length === 1) {
      give(parties[0] as string, id);
    } else if (parties.length === 0) {
      warnings.push(
        `model ${JSON.stringify(id)} is served but no provider reports it (no model_quotas evidence and no in-scope owned_by); not counted as any provider's proven model.`,
      );
    } else {
      overlaps.push({ id, providers: parties });
      warnings.push(
        `overlapping model ${JSON.stringify(id)} maps to more than one provider (${parties.join(", ")}); not counted as any provider's proven model.`,
      );
    }
  }

  const providerModels: Record<string, string[]> = {};
  for (const [provider, ids] of [...proven.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    providerModels[provider] = [...ids].sort();
  }
  return { providerModels, overlaps, warnings };
}
