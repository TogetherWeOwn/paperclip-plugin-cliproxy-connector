/**
 * Domain types for plugin-cliproxy-connector v2 (per-provider).
 *
 * The sync discovers CLIProxy accounts from `auth-files` and stores one
 * informational row per account. Routing aggregates those rows per provider
 * (and per requested model where CLIProxy reports per-model state) into a
 * single `allowed | exhausted | unknown` verdict. Field names on the cached
 * quota rows deliberately mirror `shared/ai-connection-usage.d.ts`
 * (`AiConnectionUsage` / `AiConnectionUsageLimit`) so serving them through
 * the eventual upstream core hook (proposal §5, push or pull shape) is a
 * format no-op.
 */

/** One normalized quota window on a cached per-account row. */
export interface UsageLimitRow {
  /** Window id as classified by the provider parser, e.g. `claude:5h`. */
  id: string;
  /** Human label for the UI, e.g. `Claude 5h unified`. */
  label: string;
  /** 0-100+ percent of the window consumed, when known. */
  usedPercent: number | null;
  /** 0-100 percent of the window remaining, when known. */
  remainingPercent: number | null;
  /** ISO timestamp at which this window resets, when known. */
  resetsAt: string | null;
  /** True when the provider reports this window exhausted. */
  limitReached: boolean;
  /**
   * Whether the account may run now under this window. `null` means the
   * provider exposes no admission signal for this window.
   */
  allowed: boolean | null;
  /** True when this window gates routing decisions for its provider. */
  gating: boolean;
  /**
   * ISO time the observation behind this window was taken. Passive
   * `auth-files` signals carry their own `observed_at` (which only refreshes
   * when the account serves traffic); plugin-quota limits fetched at sync time
   * carry the sync's fetch time. Null/undefined (e.g. rows cached before this
   * field existed) falls back to the row's `checkedAt`. The router treats a
   * window whose observation is older than the grace window as `unknown`
   * (fail-open candidate), never as proof of health or exhaustion.
   */
  observedAt?: string | null;
  /**
   * Lowercased model names this window's signal applies to, or `null` when the
   * signal is account-level and applies to every model. Sourced from
   * CLIProxy's per-model quota observations (`model_quotas` keyed by model).
   */
  models?: string[] | null;
  /**
   * Display-only quota `summary[]` entries from the plugin payload (and/or
   * bucket), e.g. human-readable plan or window notes. Never gates routing;
   * the router ignores this field.
   */
  metrics?: string[] | null;
}

/**
 * Totally-ordered freshness of a cached observation.
 * `fresh` — within maxAge. `stale` — within the grace window (fail-open
 * candidates only). `expired` — beyond grace, treated as `unknown`.
 */
export type Freshness = "fresh" | "stale" | "expired" | "missing";

/** Per-account lifecycle state as reconciled by CLIProxy (informational). */
export type AccountStatus = "active" | "cooling" | "error" | "disabled";

/** Cached per-account usage row, one per discovered CLIProxy account. */
export interface AccountUsageRow {
  /**
   * Stable row key: `acct-<sha256[0..16]>` over the entry's stable identity
   * (`id`, else `path`, else provider+label+email). Never a raw identifier.
   */
  key: string;
  /** CLIProxy provider string, normalized lowercase, e.g. `claude`. */
  provider: string;
  /** Raw provider word from the entry, for UI labels. */
  channel: string;
  /** Lifecycle state; `disabled` rows are excluded from aggregation. */
  status: AccountStatus;
  /** CLIProxy `status_message`, when present (operational note, never a key). */
  statusMessage: string | null;
  /** Account priority from the entry (`priority`), when exposed. */
  priority: number | null;
  limits: UsageLimitRow[];
  /** Plan label from the provider payload, when present (display only). */
  planType: string | null;
  /**
   * ISO time the sync fetched this row (cache age). Drives the bounded
   * fail-open / then-unknown when sync dies. Per-window observation age lives
   * on each limit's `observedAt` — an idle account's passive observation can
   * be hours old while its cache row is minutes old.
   */
  checkedAt: string;
  /** Freshness as classified at read time (not stored; computed by router). */
  freshness?: Freshness;
  /** `plugin:<id>` — matches the future core `source` convention. */
  source: string;
  /** True when the provider exposes no usable quota data (`unknown` path). */
  quotaBlind: boolean;
  /**
   * Why the account is quota-blind (null when it is not). Display only:
   * "upstream exposes nothing" (the provider publishes no quota),
   * "local estimate" (client-side estimates such as NIM), or
   * "no usable quota windows". Rows cached before this field existed carry
   * no value; readers fall back to deriving it from the provider.
   */
  quotaBlindReason?: string | null;
  /** Opaque sha256 of the upstream account identity. Never a raw email/label. */
  accountHash: string | null;
  /** Last error for this account (fetch/parse), if any. Never holds the key. */
  lastError: string | null;
  /** True when an unavailable/cooldown state was observed for this account. */
  coolingDown: boolean;
  /** ISO time a cooldown lifts, when the provider reports one. */
  cooldownUntil: string | null;
}

/** Aggregate routing state for one provider (and requested model). */
export type ProviderState = "allowed" | "exhausted" | "unknown";

/** Strike-budget state. Persisted in plugin state, never derived from config. */
export interface StrikeBudgetState {
  /** ISO timestamps of management-auth failures in the trailing window. */
  failures: string[];
  /** True once the budget is spent; only a board re-enable clears it. */
  disabled: boolean;
  /** ISO time the budget was spent, if ever. */
  disabledAt: string | null;
  /** Human reason recorded when disabled; surfaced board-visible. */
  disabledReason: string | null;
  /** True once any 401/403 has marked the secret bad. */
  secretBad: boolean;
}

/** One served model id claimed by more than one provider (lowercased). */
export interface ModelOverlap {
  id: string;
  /** Sorted provider words that all plausibly serve it. */
  providers: string[];
}

/** Drift finding from one sync run (per provider, never per account). */
export interface DriftFinding {
  kind:
    | "unconfigured-provider"
    | "missing-connection"
    | "no-enabled-accounts"
    | "model-overlap"
    | "untrusted-auth-file";
  /** Provider the finding is about (normalized lowercase). */
  provider: string;
  detail: string;
}

/**
 * A sync failure that never became a `SyncSummary`: non-auth fetch/parse
 * errors and unresolvable secrets. Persisted under its own state key WITHOUT
 * touching `last-sync.finishedAt` (which drives the min-interval check), so
 * the page can show the failure instead of a stale "last successful run".
 */
export interface SyncFailure {
  /** ISO time the failed attempt started. */
  attemptedAt: string;
  /** Human reason; never holds key material. */
  message: string;
}

/** Result of one sync run (persisted summary + returned to the on-demand route). */
export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  accountsSeen: number;
  rowsWritten: number;
  drift: DriftFinding[];
  errors: string[];
  skipped: boolean;
  skipReason: string | null;
  /**
   * Proven served-model ids per provider from this run's `/v1/models` +
   * auth-file derivation (lowercased). Absent when the catalog was
   * unavailable (missing client key or failed fetch); the page then says
   * overlap detection is off instead of showing stale lists.
   */
  providerModels?: Record<string, string[]>;
  /** Overlapping served ids from this run (excluded from every proven list). */
  modelOverlaps?: ModelOverlap[];
}
