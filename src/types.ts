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
   * True when this window came from a live provider API call through the
   * pinned `POST /v0/management/api-call` shapes (frozen templates for
   * Antigravity and Devin, the dedicated download + literal-header key call
   * for Meta) rather than passive `auth-files` signals or a plugin quota
   * route. Display only — the router gates on `gating` either way; the
   * "Usage & quota" page labels these windows "via provider API".
   */
  viaProviderApi?: boolean | null;
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
  /**
   * Operator-set display label for the account table (scrubbed `note`, else a
   * scrubbed non-email `label`; null when neither qualifies). Display only —
   * never a routing key, never an email unless `showAccountEmails` is on.
   */
  displayLabel?: string | null;
  /**
   * True when the account needs a fresh sign-in (stock v8 `requires_sign_in` /
   * `next_action`, or an `invalid_grant` / `unauthorized` cooldown). Badge
   * only — never triggers a reset or re-login.
   */
  needsSignIn?: boolean;
  /** Scrubbed recovery hint behind the badge, when the entry carries one. */
  needsSignInHint?: string | null;
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
  /**
   * Latest paid-credits reading from the passive signals (Codex
   * `x-codex-credits-*`), or null/absent when the account reports none.
   * Display only unless the provider row opts in with
   * `creditsCountAsHeadroom`, which lets a positive reading cover exhausted
   * quota windows (never a 429 cooldown or `retry-after`).
   */
  credits?: CreditsReading | null;
}

/** One paid-credits reading (Codex `x-codex-credits-*` headers). */
export interface CreditsReading {
  /** `x-codex-credits-has-credits`, when parseable. */
  hasCredits: boolean | null;
  /** `x-codex-credits-unlimited`, when parseable. */
  unlimited: boolean | null;
  /** `x-codex-credits-balance` as a number, when parseable. */
  balance: number | null;
  /** ISO time of the observation the reading came from. */
  observedAt: string | null;
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
 * One tracked drift finding in the ledger: per drift key (`kind + provider +
 * detail` — details are count-free and stable) with first/last seen times and
 * the last time it was written to the activity feed. Drives state-change
 * logging: one row when a finding appears, one when it clears, and at most one
 * daily reminder while it persists.
 */
export interface DriftLedgerEntry {
  kind: string;
  provider: string;
  detail: string;
  /** ISO time the finding was first seen. */
  firstSeenAt: string;
  /** ISO time the finding was last present in a successful sync. */
  lastSeenAt: string;
  /** ISO time the finding last produced an activity row. */
  lastLoggedAt: string;
}

/** Drift ledger persisted in plugin state, keyed by drift key. */
export type DriftLedger = Record<string, DriftLedgerEntry>;

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
  /**
   * Stable dedupe signature for activity logging (e.g. `secret-empty`,
   * `auth-rejected`, `sync-error`). Repeated identical failures log once,
   * with at most one reminder per 24 h while the same failure persists.
   */
  failureKind?: string;
  /** ISO time this failure last produced an activity row. */
  lastLoggedAt?: string;
}

/**
 * Provider-side spend snapshot (OpenRouter credits). Stored under its own
 * state key, never mixed into quota rows. Only the four numeric/identity
 * fields below are kept — the raw credits payload is never persisted.
 */
export interface ProviderSpend {
  /** Always `openrouter`: the only spend source today. */
  provider: "openrouter";
  /** `data.total_credits` from the credits endpoint, when parseable. */
  totalCredits: number;
  /** `data.total_usage` from the credits endpoint, when parseable. */
  totalUsage: number;
  /** ISO time the credits were fetched. Every usage-page section shows this. */
  fetchedAt: string;
}

/**
 * Spend state: the last-known snapshot plus the latest soft failure note
 * (scrubbed). A failed fetch keeps the previous snapshot and records its
 * note here, so the page shows last-known data with its timestamp instead of
 * a fresh-looking or silently empty section.
 */
export interface StoredSpend {
  data: ProviderSpend | null;
  note: string | null;
}

/** One aggregated recent-request bucket (server-generated time label only). */
export interface RequestBucket {
  /** Bucket label as reported by CLIProxy (e.g. a `HH:MM` label), never free text. */
  time: string;
  success: number;
  failed: number;
}

/**
 * Per-provider request counts aggregated in the worker from
 * `GET /v0/management/api-key-usage`. The composite `base_url|api_key` keys
 * are discarded during aggregation and structurally cannot reach this shape:
 * there is no key field, only provider-level totals.
 */
export interface ProviderRequestCounts {
  /** Normalized lowercase provider word (`unknown` when CLIProxy reports none). */
  provider: string;
  success: number;
  failed: number;
  total: number;
  recent: RequestBucket[];
  /** ISO time the counts were fetched. Every usage-page section shows this. */
  fetchedAt: string;
}

/**
 * Request-count state: the last-known per-provider aggregates plus the
 * latest soft failure note (scrubbed). A failed fetch keeps the previous
 * aggregates and records its note here.
 */
export interface StoredRequestCounts {
  lanes: ProviderRequestCounts[];
  fetchedAt: string | null;
  note: string | null;
  /**
   * ISO time of the last 401/403 on `api-key-usage`. Probes stay off while
   * this is within the strike window (30 min): a rejected endpoint must not
   * be re-probed every sync run. Absent on snapshots written before the
   * backoff existed (treated as no pause).
   */
  authRejectedAt?: string | null;
}

/** Result of one sync run (persisted summary + returned to the on-demand route). */
export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  accountsSeen: number;
  rowsWritten: number;
  drift: DriftFinding[];
  /**
   * Findings suppressed by the operator's ignore config (`ignoredProviders`,
   * `ignoredAuthFileRefs`): explicitly accepted, never alerted. Shown on the
   * plugin page as accepted, not as drift. Absent on summaries written before
   * the ignore config existed.
   */
  acceptedDrift?: DriftFinding[];
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
  /**
   * Human display names per proven model id (`auth-files/models`
   * `display_name`, scrubbed, display only — never a routing key), keyed by
   * provider then lowercase id. Absent when no file answered with names.
   */
  providerModelNames?: Record<string, Record<string, string>>;
  /** Overlapping served ids from this run (excluded from every proven list). */
  modelOverlaps?: ModelOverlap[];
}
