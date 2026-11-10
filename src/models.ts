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
 * Attribution rules (no hard-coded id lists, no substring parsing):
 * - Namespaced ids (`ns/rest`) attribute by namespace: the namespace equals
 *   its provider string, or the explicit `NAMESPACE_TO_PROVIDER` table
 *   (`nvidia` → `nvidia-nim`, `cloudflare` → `cloudflare-workers-ai`). The
 *   namespace wins over `/v1/models` `owned_by`: Devin reports `owned_by:
 *   anthropic` for `devin/claude-…`, but the quota — and the model — is
 *   Devin's. Future providers (e.g. `openrouter/…`) resolve by exact match
 *   with no code change.
 * - Bare ids attribute by per-provider served evidence, grouped by auth-file
 *   `provider`, never by `owned_by`: the live per-credential served set from
 *   `GET auth-files/models?name=<file>` where the file answered successfully
 *   (empty answers included — live membership is authoritative for that
 *   credential), else per-provider `model_quotas` keys for credentials without
 *   live evidence. A bare id with no served evidence falls back to `owned_by`
 *   through an explicit vendor-name table (`anthropic` → `claude`, `openai` →
 *   `codex`; anything else must equal its provider string) — but only for
 *   providers without live evidence this run. This covers quota-blind
 *   providers such as Meta, whose accounts carry no per-model state but whose
 *   served ids still carry an honest `owned_by`.
 * - A bare id attributable to more than one enabled provider (the canonical
 *   case is stock `claude-sonnet-4-6`, served by both claude and antigravity)
 *   is an overlap: it is flagged, and it is not counted as any provider's
 *   proven model. The plugin never requires or suggests CLIProxy config; the
 *   openai-compat `prefix` field is only an optional operator-side fix,
 *   mentioned in the README.
 */

import { NAMESPACE_TO_PROVIDER, isCredentialToken, isEmailLike, tokenContainsEmail } from "./parsers.js";

export interface ServedModel {
  /** Served id, lowercased for matching. */
  id: string;
  /** Raw `owned_by` value, or null when absent. Never used for quota grouping. */
  ownedBy: string | null;
  /**
   * Human display name from the served set (`display_name`), scrubbed and
   * length-capped. Display only — never a routing or matching key.
   */
  displayName: string | null;
}

/**
 * Human provider labels for the UI. Falls back to the raw provider word;
 * never used for routing, matching, or config.
 */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "ChatGPT Codex",
  meta: "Meta Muse",
  antigravity: "Antigravity",
  devin: "Devin",
  synthetic: "Synthetic",
  "nvidia-nim": "Nvidia NIM",
  cloudflare: "Cloudflare",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  zai: "Z.ai",
  "opencode-go": "opencode-go",
  openrouter: "OpenRouter",
};

/** Human provider label for the UI (raw word fallback, never routing). */
export function providerDisplayName(provider: string): string {
  const word = provider.trim().toLowerCase();
  return PROVIDER_DISPLAY_NAMES[word] ?? provider;
}

/** Reject email/credential-shaped display names before capping; callers fall back to the id. */
export function scrubDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  // Emails never render as model names — whole or glued inside other text
  // (`"Available for user@example.com"`); rejects fall back to the id.
  if (isEmailLike(s)) return null;
  for (const tok of s.split(/\s+/)) {
    if (tokenContainsEmail(tok) || isCredentialToken(tok)) return null;
  }
  const capped = s.length > 80 ? `${s.slice(0, 77)}...` : s;
  return capped;
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
export function parseModelsPayload(payload: unknown): {
  models: ServedModel[];
  warnings: string[];
  /** A supported list container was found, even if empty or containing unusable entries. */
  recognized: boolean;
} {
  const warnings: string[] = [];
  const models: ServedModel[] = [];
  const root = asObj(payload);
  const list: unknown[] | undefined = Array.isArray(payload)
    ? payload
    : root
      ? (["data", "models", "items", "results"]
          .map((k) => (root as Json)[k])
          .find((v) => Array.isArray(v)) as unknown[] | undefined)
      : undefined;
  const recognized = list !== undefined;
  const entries = list ?? [];
  if (entries.length === 0) {
    warnings.push("models payload holds no entries; no provider has proven models this run.");
    return { models, warnings, recognized };
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
    const displayRaw = o ? (o.display_name ?? o.displayName ?? null) : null;
    models.push({
      id,
      ownedBy: typeof ownedRaw === "string" && ownedRaw.trim() ? ownedRaw.trim() : null,
      displayName: scrubDisplayName(displayRaw),
    });
  }
  return { models, warnings, recognized };
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
 * Vendor names from `/v1/models` `owned_by` that differ from their provider
 * string (explicit table, not substring parsing). Every other `owned_by`
 * must equal its provider string to claim an id.
 */
export const OWNED_BY_TO_PROVIDER: Record<string, string> = {
  anthropic: "claude",
  openai: "codex",
};

/** Attribute a namespace to its in-scope provider: exact match or the explicit table. */
export function providerForNamespace(
  namespace: string,
  inScope: Set<string>,
): string | null {
  const ns = namespace.toLowerCase();
  if (inScope.has(ns)) return ns;
  const mapped = NAMESPACE_TO_PROVIDER[ns];
  if (mapped && inScope.has(mapped)) return mapped;
  return null;
}

/** Attribute an `owned_by` value to its in-scope provider: exact match or the explicit table. */
export function providerForOwnedBy(ownedBy: string, inScope: Set<string>): string | null {
  const owned = ownedBy.trim().toLowerCase();
  if (!owned) return null;
  if (inScope.has(owned)) return owned;
  const mapped = OWNED_BY_TO_PROVIDER[owned];
  if (mapped && inScope.has(mapped)) return mapped;
  return null;
}

/**
 * Derive each provider's proven served ids plus the overlap list.
 *
 * - Namespaced ids attribute by namespace (namespace wins over `owned_by`).
 *   A namespace that names no in-scope provider is unattributed with a
 *   warning.
 * - Bare ids attribute to their single claimant: the live per-credential
 *   served set for credentials whose file answered successfully (the caller
 *   already withholds those credentials' `model_quotas` keys), else
 *   `model_quotas` evidence, else their `owned_by` provider when that
 *   provider is in scope and has no live evidence this run. Two or more
 *   attributing providers is an overlap: flagged, and proven for nobody.
 */
export function deriveProviderModels(
  served: ServedModel[],
  opts: {
    /** Lowercase provider words in scope (discovered + configured). */
    authProviders: string[];
    /** Per-provider observed `model_quotas` keys (lowercased). */
    observedKeysByProvider: Map<string, Set<string>>;
    /**
     * Per-provider live served ids from `GET auth-files/models?name=<file>`
     * (lowercased), grouped by auth-file provider. Absent/empty when the
     * endpoint was unavailable this run — derivation falls back to the
     * `model_quotas` + `owned_by` heuristic with a warning.
     */
    servedByProvider?: Map<string, Set<string>>;
    /**
     * Lowercase providers with at least one successfully fetched live served
     * set this run. Their `owned_by` claims are ignored: live membership is
     * authoritative for them (a successful empty set means the provider
     * serves nothing in the catalog), and the `owned_by` fallback only
     * covers providers without live evidence.
     */
    liveOkProviders?: string[];
    /**
     * Lowercase providers eligible to claim via the `owned_by` fallback:
     * enabled discovered providers (at least one non-disabled account). A
     * disabled or configured-but-accountless provider has no credential
     * evidence and must not claim through `owned_by`. Defaults to the full
     * scope when omitted (callers without credential data).
     */
    ownedByEligible?: string[];
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
      const provider = providerForNamespace(ns, inScope);
      if (provider === null) {
        warnings.push(
          `model ${JSON.stringify(id)} names a namespace ${JSON.stringify(ns)} with no in-scope provider; not counted as any provider's proven model.`,
        );
        continue;
      }
      give(provider, id);
      continue;
    }
    const quotaClaimants = [...inScope].filter(
      (p) => opts.observedKeysByProvider.get(p)?.has(id) ?? false,
    );
    const servedClaimants = opts.servedByProvider
      ? [...inScope].filter((p) => {
          const set = opts.servedByProvider?.get(p);
          return set ? [...set].some((s) => s.toLowerCase() === id) : false;
        })
      : [];
    const claimants = [...new Set([...quotaClaimants, ...servedClaimants])].sort();
    const liveOk = new Set((opts.liveOkProviders ?? []).map((p) => p.toLowerCase()));
    const ownedInScope = ownedBy ? providerForOwnedBy(ownedBy, inScope) : null;
    // Live membership supersedes the fallback: a provider whose served set
    // answered successfully never claims via `owned_by` (its live set — even
    // an empty one — already says what it serves). Providers without an
    // enabled account never claim via `owned_by` either: a disabled or
    // accountless provider's fallback claim would fabricate overlaps that
    // hide the actually-serving provider's usable model.
    const eligible = opts.ownedByEligible ? new Set(opts.ownedByEligible.map((p) => p.toLowerCase())) : null;
    // An in-scope exact match that cannot claim must not block the vendor
    // alias: `openai` configured without an account (in scope, ineligible)
    // must not swallow codex's fallback claim. The live block stays
    // absolute — live membership already spoke for that provider — only an
    // eligibility block falls through to the alias.
    const ownedClaimed = (() => {
      if (!ownedInScope) return null;
      if (!liveOk.has(ownedInScope) && (!eligible || eligible.has(ownedInScope))) return ownedInScope;
      if (!eligible || liveOk.has(ownedInScope)) return null;
      const ownedRaw = ownedBy ? ownedBy.trim().toLowerCase() : "";
      const mapped = ownedRaw ? OWNED_BY_TO_PROVIDER[ownedRaw] : undefined;
      if (mapped && mapped !== ownedInScope && inScope.has(mapped) && !liveOk.has(mapped) && eligible.has(mapped)) {
        return mapped;
      }
      return null;
    })();
    const parties = [...new Set([...claimants, ...(ownedClaimed ? [ownedClaimed] : [])])].sort();
    if (parties.length === 1) {
      give(parties[0] as string, id);
    } else if (parties.length === 0) {
      warnings.push(
        `model ${JSON.stringify(id)} is served but no provider reports it (no served-set or model_quotas evidence and no in-scope owned_by); not counted as any provider's proven model.`,
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
