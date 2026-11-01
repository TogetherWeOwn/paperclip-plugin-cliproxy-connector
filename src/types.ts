/**
 * Domain types for plugin-cliproxy-connector.
 *
 * Field names on the cached usage rows deliberately mirror
 * `shared/ai-connection-usage.d.ts` (`AiConnectionUsage` / `AiConnectionUsageLimit`)
 * so serving them through the eventual upstream core hook (proposal §5, push or
 * pull shape) is a format no-op.
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
}

/**
 * Totally-ordered freshness of a cached observation.
 * `fresh` — within maxAge. `stale` — within the grace window (fail-open
 * candidates only). `expired` — beyond grace, treated as `unknown`.
 */
export type Freshness = "fresh" | "stale" | "expired" | "missing";

/** Cached per-account usage row, one per CLIProxy prefix. */
export interface AccountUsageRow {
  /** CLIProxy per-credential prefix, e.g. `acct-claude-2`. Also the map key. */
  prefix: string;
  /** Paperclip connection id from the operator-maintained map. */
  connectionId: string | null;
  /** Provider family for parser selection, e.g. `claude`, `synthetic`. */
  provider: string;
  /** Protocol family pool this account joins: `messages` | `responses`. */
  poolFamily: "messages" | "responses" | "unknown";
  limits: UsageLimitRow[];
  /** Plan label from the provider payload, when present (display only). */
  planType: string | null;
  /** ISO time the observation was taken (quota `observed_at` or fetch time). */
  checkedAt: string;
  /** Freshness as classified at read time (not stored; computed by router). */
  freshness?: Freshness;
  /** `plugin:<id>` — matches the future core `source` convention. */
  source: string;
  /** True when the provider exposes no usable quota data (`unknown` path). */
  quotaBlind: boolean;
  /** Opaque sha256 of the upstream account identity. Never a raw email/label. */
  accountHash: string | null;
  /** Last error for this account (fetch/parse), if any. Never holds the key. */
  lastError: string | null;
  /** True when a 429/cooldown state was observed for this account. */
  coolingDown: boolean;
  /** ISO time a 429-driven cooldown lifts, when the provider reports one. */
  cooldownUntil: string | null;
}

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

/** Drift finding from one sync run. */
export interface DriftFinding {
  kind:
    | "unmapped-account"
    | "mapped-but-missing"
    | "duplicate-prefix"
    | "unkeyed-observation"
    | "identity-mismatch";
  prefix: string;
  detail: string;
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
}
