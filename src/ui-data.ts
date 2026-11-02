/**
 * Plugin page + dashboard widget data (TWO-679 v2, per-provider).
 *
 * Served worker-side via `ctx.data` (`page`, `widget`); the React bundle in
 * `ui/` renders it. Everything here is derived from the plugin's own cache —
 * never upstream account identity beyond opaque hashes and the operator's own
 * connection ids.
 *
 * Each `providers[]` row gets one provider card: the aggregate verdict
 * (provider level, no requested model), its `retryAt`, freshness, the
 * `completeInventory` flag that gates wait/resume, and the mapped connection.
 * Discovered accounts render as informational detail under their provider —
 * they are never addressed, keyed, or provisioned by this UI.
 *
 * Audience (proposal §4 point 4): this page shows upstream account quota state
 * (providers, plan labels, per-account status). The operator confirms which
 * company roles may view plugin pages via `audienceConfirmed` before relying
 * on this page; until then the audience notice below stays on screen.
 */

import { aggregateProvider } from "./aggregate.js";
import { graceMs, maxAgeMs, type ConnectorConfig } from "./config.js";
import { normalizeProvider, quotaBlindReason } from "./parsers.js";
import { strikeWaitUntil } from "./sync.js";
import type {
  AccountUsageRow,
  DriftFinding,
  Freshness,
  ProviderRequestCounts,
  ProviderState,
  StoredRequestCounts,
  StoredSpend,
  StrikeBudgetState,
  SyncFailure,
  SyncSummary,
} from "./types.js";

export const AUDIENCE_NOTICE =
  "Audience: this page shows upstream AI account quota state (providers, plan labels, per-account status). " +
  "Confirm which company roles may view plugin pages and that this exposure is intended (proposal §4 point 4), " +
  "then set audienceConfirmed: true in the company config.";

export interface ProviderAccountDetail {
  /** Stable row key (`acct-<hash>`); never a raw identifier. */
  key: string;
  /**
   * Display label for the account table: the row key shortened to
   * `acct-<8hex>…`. Still a hash — never a raw identifier.
   */
  maskedLabel: string;
  status: string;
  statusMessage: string | null;
  priority: number | null;
  planType: string | null;
  quotaBlind: boolean;
  /** Display-only blind reason (null when the account is not blind). */
  quotaBlindReason: string | null;
  freshness: Freshness;
  checkedAt: string;
  limits: AccountCardLimit[];
  /**
   * Worst remaining percent across the account's windows (null when no
   * window reports one). Drives the usage table's remaining-% sort.
   */
  worstRemaining: number | null;
  /** Earliest reset across the account's windows, when known. */
  nextReset: string | null;
  nextResetIn: string | null;
  lastError: string | null;
  coolingDown: boolean;
  cooldownUntil: string | null;
  cooldownIn: string | null;
}

export interface AccountCardLimit {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  resetIn: string | null;
  limitReached: boolean;
  allowed: boolean | null;
  gating: boolean;
  stale: boolean;
  models: string[] | null;
  /** Display-only quota `summary[]` entries attached to this window. */
  metrics: string[] | null;
  /**
   * True when this window came from a live provider API call (pinned
   * `api-call` template); the usage page labels it "via provider API".
   */
  viaProviderApi: boolean | null;
}

export interface ProviderCard {
  provider: string;
  connectionId: string;
  completeInventory: boolean;
  state: ProviderState;
  retryAt: string | null;
  retryIn: string | null;
  freshness: Freshness;
  waitResumeOff: boolean;
  enabledAccounts: number;
  headroomAccounts: number;
  /** Blind enabled accounts under this provider (disabled rows never count). */
  blindAccounts: number;
  /**
   * Earliest known future window reset across the provider's accounts, or
   * null when none is known. Informational: unlike `retryAt` (set only behind
   * an exhausted verdict) this is present for allowed providers too.
   */
  nextReset: string | null;
  nextResetIn: string | null;
  /**
   * Most common blind reason among the provider's blind accounts (null when
   * none are blind). Displayed as the blind badge's reason on the usage page.
   */
  blindReason: string | null;
  reason: string;
  /** Proven served-model ids for this provider (stock ids), or [] when unknown. */
  models: string[];
  accounts: ProviderAccountDetail[];
}

export interface PageData {
  audienceNotice: string;
  audienceConfirmed: boolean;
  generatedAt: string;
  sync: {
    ranAt: string | null;
    accountsSeen: number;
    rowsWritten: number;
    skipped: boolean;
    skipReason: string | null;
    errors: string[];
    /** Latest failed attempt (own state key; never moves `ranAt`). Null when the last attempt succeeded. */
    lastError: string | null;
    lastAttemptAt: string | null;
  };
  strike: {
    disabled: boolean;
    disabledAt: string | null;
    disabledReason: string | null;
    secretBad: boolean;
    recentFailures: string[];
    /**
     * ISO time when the next probe is allowed again (the rolling 30 min
     * window has room). Null when probing is currently allowed. The page
     * renders this as "wait until <time>" instead of offering a probe that
     * would push the host past 2 rejections per 30 min.
     */
    waitUntil: string | null;
  };
  drift: DriftFinding[];
  /**
   * Findings the operator explicitly accepted via `ignoredProviders` /
   * `ignoredAuthFileRefs`: shown as accepted, never counted as drift and never
   * alerted. Absent on summaries written before the ignore config existed.
   */
  accepted: DriftFinding[];
  providers: ProviderCard[];
  earliestReset: string | null;
  /** Proven served-model ids per provider from the latest sync (stock ids). */
  providerModels: Record<string, string[]>;
  /** Served ids claimed by more than one provider (proven for nobody). */
  modelOverlaps: Array<{ id: string; providers: string[] }>;
  /**
   * Why the catalog is unavailable (missing client key, failed fetch), or
   * null when derivation ran. Overlap detection is off while this is set.
   */
  modelsNote: string | null;
}

export interface WidgetData {
  generatedAt: string;
  ok: boolean;
  status: string;
  providers: number;
  allowed: number;
  exhausted: number;
  unknownProviders: number;
  waitResumeOff: number;
  driftCount: number;
  /** Served ids claimed by more than one provider (also counted in drift). */
  modelOverlapCount: number;
  earliestReset: string | null;
  earliestResetIn: string | null;
}

/**
 * Provider spend section: the last-known OpenRouter credits snapshot. When no
 * secret is configured the page shows "not configured", never an error; when a
 * fetch fails the last-known figures stay with their timestamp plus the soft
 * note (T9). `remaining` is plain arithmetic on the two stored figures.
 */
export interface SpendSection {
  configured: boolean;
  totalCredits: number | null;
  totalUsage: number | null;
  remaining: number | null;
  fetchedAt: string | null;
  note: string | null;
}

/**
 * Per-lane usage section at request-count fidelity (labelled "requests", never
 * tokens): the worker-aggregated `api-key-usage` lanes. Composite
 * `base_url|api_key` keys were discarded at the parse boundary, so lanes carry
 * provider words and counts only. Off by default (`apiKeyUsageEnabled`).
 */
export interface UsageCountsSection {
  enabled: boolean;
  lanes: ProviderRequestCounts[];
  fetchedAt: string | null;
  note: string | null;
  fidelityNote: string;
}

/** Request-count fidelity disclaimer: shown verbatim under the usage section. */
export const REQUEST_COUNT_FIDELITY_NOTE =
  "Request counts only (api-key lanes). No per-lane token split exists from a lawful read-only source; " +
  "OAuth lanes are invisible to this endpoint and are not represented here.";

/**
 * Static lane map, derived from the cost-integration plan §1.3 on
 * 2026-11-01 — not from the ledger. The flag travels with the data so the page
 * can never render the map without its provenance, and `derivedAt` is the
 * section's timestamp. Any change to the underlying agent lanes means
 * re-deriving this table (and its date), not editing numbers in place.
 */
export const LANE_MAP_DERIVED_AT = "2026-11-01";
export const LANE_MAP_FLAG = `Config-derived mapping (derived ${LANE_MAP_DERIVED_AT}). Not ledger data.`;

export interface LaneMapRow {
  lane: string;
  agents: number;
  provider: string;
  model: string;
}

export const LANE_MAP: LaneMapRow[] = [
  { lane: "wonder-full", agents: 7, provider: "anthropic", model: "opus" },
  { lane: "spark", agents: 3, provider: "anthropic", model: "opus" },
  { lane: "opus", agents: 2, provider: "anthropic", model: "opus" },
];

export interface LaneMapSection {
  derivedAt: string;
  flag: string;
  lanes: LaneMapRow[];
}

/**
 * Native cost views live outside this plugin (write-path and budget policy are
 * out of scope by design): the page links out with literal path constants, so
 * no payload-derived href can ever steer navigation (T4).
 */
export const NATIVE_COSTS_URL = "/costs";
export const NATIVE_BUDGETS_URL = "/budgets/overview";

export interface NativeLinksSection {
  costsUrl: string;
  budgetsUrl: string;
}

/**
 * "Usage & quota" page data: the sync summary plus one card per provider
 * with headroom counts, the earliest reset, freshness, blind badges, and the
 * per-account table rows (masked labels, bars per window, cooldowns).
 * Derived entirely from the already-synced cache — never a live read, and
 * never the destructive usage-queue endpoint.
 *
 * Read-model sections (spend, per-lane usage, lane map, native links) ride the
 * same cache: every section carries its own timestamp (`quotaFetchedAt` for
 * the provider cards, whose per-account `checkedAt` fields give finer grain).
 */
export interface UsagePageData {
  audienceNotice: string;
  audienceConfirmed: boolean;
  generatedAt: string;
  sync: PageData["sync"];
  providers: ProviderCard[];
  earliestReset: string | null;
  earliestResetIn: string | null;
  /** Latest per-window observation behind `providers` (observedAt, else row fetch). */
  quotaFetchedAt: string | null;
  spend: SpendSection;
  usage: UsageCountsSection;
  laneMap: LaneMapSection;
  links: NativeLinksSection;
}

export function resetIn(resetAt: string | null, nowMs: number): string | null {
  if (!resetAt) return null;
  const t = Date.parse(resetAt);
  if (Number.isNaN(t)) return null;
  const diff = t - nowMs;
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function buildPageData(args: {
  now: string;
  config: ConnectorConfig;
  rows: Record<string, AccountUsageRow>;
  lastSync: SyncSummary | null;
  strike: StrikeBudgetState;
  lastFailure?: SyncFailure | null;
}): PageData {
  const { now, config, rows, lastSync, strike, lastFailure } = args;
  const nowMs = Date.parse(now);
  const modelOverlaps = lastSync?.modelOverlaps ?? [];
  const catalogError =
    lastSync === null
      ? null
      : (lastSync.errors.find((e) => e.includes("/v1/models") || e.includes("clientApiKeySecretRef")) ?? null);
  const modelsNote =
    lastSync === null
      ? "no sync has run yet; model → provider derivation has no catalog."
      : lastSync.providerModels === undefined
        ? (catalogError ?? "model catalog unavailable this run; overlap detection is off.")
        : null;

  const providerModels = lastSync?.providerModels ?? {};
  const providers = buildProviderCards({ config, rows, now, nowMs, providerModels });

  const earliestReset = earliestRetryAt(providers);

  return {
    audienceNotice: AUDIENCE_NOTICE,
    audienceConfirmed: config.audienceConfirmed,
    generatedAt: now,
    // A failure newer than the last successful run is shown explicitly so
    // the page never silently presents stale success as current state. An
    // older failure stays recorded but shows neither message nor attempt
    // time next to the newer success.
    sync: buildSyncSection(lastSync, lastFailure),
    strike: {
      disabled: strike.disabled,
      disabledAt: strike.disabledAt,
      disabledReason: strike.disabledReason,
      secretBad: strike.secretBad,
      recentFailures: strike.failures,
      waitUntil: strikeWaitUntil(strike.failures, nowMs),
    },
    drift: lastSync?.drift ?? [],
    accepted: lastSync?.acceptedDrift ?? [],
    providers,
    earliestReset,
    providerModels,
    modelOverlaps,
    modelsNote,
  };
}

function toAccountDetail(
  row: AccountUsageRow,
  nowMs: number,
  maxAge: number,
  grace: number,
): ProviderAccountDetail {
  const at = Date.parse(row.checkedAt);
  const age = Number.isNaN(at) ? Infinity : nowMs - Math.min(at, nowMs);
  // Row-level freshness is informational only; the aggregate verdict owns the
  // routing freshness. Same sync-relative bounds as the router.
  const freshness: Freshness =
    !Number.isFinite(age) || age < 0
      ? "missing"
      : age <= maxAge
        ? "fresh"
        : age <= grace
          ? "stale"
          : "expired";
  const stale = freshness !== "fresh";
  // Rows cached before `quotaBlindReason` existed carry no value: derive the
  // same reason from the provider so old cache rows still badge correctly.
  const blindReason =
    row.quotaBlindReason ?? (row.quotaBlind ? quotaBlindReason(normalizeProvider(row.provider), row.limits.length > 0) : null);
  const remaining = row.limits
    .map((l) => l.remainingPercent)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  // Only future resets count as "next": a past reset is already spent, and
  // selecting it would badge the card (and page summary) with a time that
  // reads "now" while the real upcoming recovery hides behind it.
  const resetMs = row.limits
    .map((l) => (l.resetsAt ? Date.parse(l.resetsAt) : NaN))
    .filter((t) => !Number.isNaN(t) && t > nowMs);
  const nextReset = resetMs.length > 0 ? new Date(Math.min(...resetMs)).toISOString() : null;
  return {
    key: row.key,
    maskedLabel: row.key.length > 14 ? `${row.key.slice(0, 13)}…` : row.key,
    status: row.status,
    statusMessage: row.statusMessage,
    priority: row.priority,
    planType: row.planType,
    quotaBlind: row.quotaBlind,
    quotaBlindReason: blindReason,
    freshness,
    checkedAt: row.checkedAt,
    limits: row.limits.map((l) => ({
      id: l.id,
      label: l.label,
      usedPercent: l.usedPercent,
      remainingPercent: l.remainingPercent,
      resetsAt: l.resetsAt,
      resetIn: resetIn(l.resetsAt, nowMs),
      limitReached: l.limitReached,
      allowed: l.allowed,
      gating: l.gating,
      stale,
      models: l.models ?? null,
      metrics: l.metrics ?? null,
      viaProviderApi: l.viaProviderApi ?? null,
    })),
    worstRemaining: remaining.length > 0 ? Math.min(...remaining) : null,
    nextReset,
    nextResetIn: resetIn(nextReset, nowMs),
    lastError: row.lastError,
    coolingDown: row.coolingDown,
    cooldownUntil: row.cooldownUntil,
    cooldownIn: resetIn(row.cooldownUntil, nowMs),
  };
}

/** One provider card per `providers[]` row, shared by both pages. */
function buildProviderCards(args: {
  config: ConnectorConfig;
  rows: Record<string, AccountUsageRow>;
  now: string;
  nowMs: number;
  providerModels: Record<string, string[]>;
}): ProviderCard[] {
  const { config, rows, now, nowMs, providerModels } = args;
  const allRows = Object.values(rows);
  return [...config.providers]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((entry) => {
      const verdict = aggregateProvider({
        provider: entry.provider,
        model: null,
        rows: allRows,
        completeInventory: entry.completeInventory,
        config,
        now,
        poolId: undefined,
        poolThresholdPercent: undefined,
      });
      const providerRows = allRows
        .filter((r) => r.provider === entry.provider)
        .sort((a, b) => a.key.localeCompare(b.key));
      const accounts = providerRows.map((row) =>
        toAccountDetail(row, nowMs, maxAgeMs(config), graceMs(config)),
      );
      // Disabled rows never count toward the blind badge: they get no plugin
      // quota, so they usually read blind while the enabled accounts are fine.
      const countable = accounts.filter((a) => a.status !== "disabled");
      const nextReset = earliestTime(countable.map((a) => a.nextReset));
      return {
        provider: entry.provider,
        connectionId: entry.connectionId,
        completeInventory: entry.completeInventory,
        state: verdict.state,
        retryAt: verdict.retryAt,
        retryIn: resetIn(verdict.retryAt, nowMs),
        freshness: verdict.freshness,
        waitResumeOff: verdict.waitResumeOff,
        enabledAccounts: verdict.enabledAccounts,
        headroomAccounts: verdict.headroomAccounts,
        blindAccounts: countable.filter((a) => a.quotaBlind).length,
        blindReason: commonBlindReason(countable),
        nextReset,
        nextResetIn: resetIn(nextReset, nowMs),
        reason: verdict.waitResumeOff
          ? `${verdict.reason} Wait/resume is off for this provider: inventory is not confirmed complete.`
          : verdict.reason,
        models: providerModels[entry.provider] ?? [],
        accounts,
      };
    });
}

/** Most common blind reason among blind accounts; null when none are blind. */
function commonBlindReason(accounts: ProviderAccountDetail[]): string | null {
  const counts = new Map<string, number>();
  for (const a of accounts) {
    if (!a.quotaBlind || !a.quotaBlindReason) continue;
    counts.set(a.quotaBlindReason, (counts.get(a.quotaBlindReason) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [reason, count] of [...counts.entries()].sort()) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/** Earliest parseable time in the list, or null when there is none. */
function earliestTime(times: Array<string | null>): string | null {
  const parsed = times
    .filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)))
    .map((t) => Date.parse(t));
  return parsed.length > 0 ? new Date(Math.min(...parsed)).toISOString() : null;
}

function earliestRetryAt(providers: ProviderCard[]): string | null {
  return earliestTime(providers.map((p) => p.retryAt));
}

/**
 * Page-level earliest known recovery for the usage page: the retry times
 * behind exhausted verdicts plus every card's informational next reset, so
 * the summary still shows known resets when no provider is exhausted.
 */
function earliestKnownReset(providers: ProviderCard[]): string | null {
  return earliestTime(providers.flatMap((p) => [p.retryAt, p.nextReset]));
}

/**
 * Latest per-window observation across cached rows that carry quota windows.
 * Each window contributes its `observedAt` (passive `auth-files` signals carry
 * their own observation time, which only refreshes when the account serves
 * traffic), falling back to the row's `checkedAt` for rows cached before
 * per-window `observedAt` existed. Rows without limits (quota-blind providers,
 * best-effort quota failures) never contribute, and windows with no parseable
 * time never contribute: the section timestamp must reflect the age of the
 * displayed figures, not a cache refresh that left them untouched.
 */
function latestQuotaCheckedAt(rows: Record<string, AccountUsageRow>): string | null {
  let latest: string | null = null;
  let latestMs = NaN;
  for (const row of Object.values(rows)) {
    if (row.limits.length === 0) continue;
    const rowMs = Date.parse(row.checkedAt);
    for (const window of row.limits) {
      const candidate = window.observedAt ?? row.checkedAt;
      const ms = window.observedAt != null ? Date.parse(window.observedAt) : rowMs;
      if (candidate == null || Number.isNaN(ms)) continue;
      if (latest === null || ms > latestMs) {
        latest = candidate;
        latestMs = ms;
      }
    }
  }
  return latest;
}

function isFailureNewer(lastSync: SyncSummary | null, lastFailure?: SyncFailure | null): boolean {
  return Boolean(
    lastFailure &&
      (!lastSync ||
        Number.isNaN(Date.parse(lastSync.finishedAt)) ||
        Date.parse(lastFailure.attemptedAt) > Date.parse(lastSync.finishedAt)),
  );
}

function buildSyncSection(
  lastSync: SyncSummary | null,
  lastFailure: SyncFailure | null | undefined,
): PageData["sync"] {
  const showFailure = isFailureNewer(lastSync, lastFailure);
  return {
    ranAt: lastSync?.finishedAt ?? null,
    accountsSeen: lastSync?.accountsSeen ?? 0,
    rowsWritten: lastSync?.rowsWritten ?? 0,
    skipped: lastSync?.skipped ?? true,
    skipReason: lastSync?.skipReason ?? "no sync has run yet.",
    errors: lastSync?.errors ?? [],
    lastError: showFailure ? (lastFailure as SyncFailure).message : null,
    lastAttemptAt: showFailure ? (lastFailure as SyncFailure).attemptedAt : null,
  };
}

export function buildUsageData(args: {
  now: string;
  config: ConnectorConfig;
  rows: Record<string, AccountUsageRow>;
  lastSync: SyncSummary | null;
  lastFailure?: SyncFailure | null;
  /** Last-known spend snapshot (null when no sync has stored one). */
  spend?: StoredSpend | null;
  /** Last-known request-count aggregates (null when never stored). */
  counts?: StoredRequestCounts | null;
}): UsagePageData {
  const { now, config, rows, lastSync, lastFailure, spend, counts } = args;
  const nowMs = Date.parse(now);
  const providers = buildProviderCards({ config, rows, now, nowMs, providerModels: {} });
  const earliestReset = earliestKnownReset(providers);
  const totalCredits = spend?.data?.totalCredits ?? null;
  const totalUsage = spend?.data?.totalUsage ?? null;
  return {
    audienceNotice: AUDIENCE_NOTICE,
    audienceConfirmed: config.audienceConfirmed,
    generatedAt: now,
    sync: buildSyncSection(lastSync, lastFailure),
    providers,
    earliestReset,
    earliestResetIn: resetIn(earliestReset, nowMs),
    // The quota timestamp comes from the cached rows, not the sync summary:
    // `finishedAt` is sync completion time (later than the quota reads), and a
    // best-effort quota failure can still save a successful summary. Only rows
    // that actually carry quota windows qualify; null when none do. Skipped
    // runs write no rows, so they can never masquerade as a fresh fetch. Each
    // window contributes its own observation time (`observedAt`, else the row
    // fetch), so a passive window observed hours ago is never stamped with a
    // minutes-old cache refresh.
    quotaFetchedAt: latestQuotaCheckedAt(rows),
    spend: {
      configured: config.openRouterSecretRef !== undefined && config.openRouterSecretRef !== null,
      totalCredits,
      totalUsage,
      remaining:
        typeof totalCredits === "number" && typeof totalUsage === "number"
          ? totalCredits - totalUsage
          : null,
      fetchedAt: spend?.data?.fetchedAt ?? null,
      note: spend?.note ?? null,
    },
    usage: {
      enabled: config.apiKeyUsageEnabled === true,
      lanes: counts?.lanes ?? [],
      fetchedAt: counts?.fetchedAt ?? null,
      note: counts?.note ?? null,
      fidelityNote: REQUEST_COUNT_FIDELITY_NOTE,
    },
    laneMap: {
      derivedAt: LANE_MAP_DERIVED_AT,
      flag: LANE_MAP_FLAG,
      lanes: LANE_MAP,
    },
    links: {
      costsUrl: NATIVE_COSTS_URL,
      budgetsUrl: NATIVE_BUDGETS_URL,
    },
  };
}

export function buildWidgetData(args: {
  now: string;
  config: ConnectorConfig;
  rows: Record<string, AccountUsageRow>;
  lastSync: SyncSummary | null;
  strike: StrikeBudgetState;
  lastFailure?: SyncFailure | null;
}): WidgetData {
  const page = buildPageData(args);
  const nowMs = Date.parse(args.now);
  const allowed = page.providers.filter((p) => p.state === "allowed").length;
  const exhausted = page.providers.filter((p) => p.state === "exhausted").length;
  const unknownProviders = page.providers.filter((p) => p.state === "unknown").length;
  const waitResumeOff = page.providers.filter((p) => p.waitResumeOff).length;
  const status = args.strike.disabled
    ? "disabled (strike budget spent)"
    : page.sync.lastError
      ? `last sync failed: ${page.sync.lastError}`
      : page.drift.length > 0
        ? `${page.drift.length} drift finding${page.drift.length === 1 ? "" : "s"}`
        : page.providers.length === 0
          ? "no providers configured yet"
          : exhausted > 0 && allowed === 0
            ? `all routed providers exhausted (retry ${page.earliestReset ?? "unknown"})`
            : page.modelOverlaps.length > 0
              ? `healthy (${page.modelOverlaps.length} overlapping model${page.modelOverlaps.length === 1 ? "" : "s"} excluded from proven models)`
              : "healthy";
  return {
    generatedAt: args.now,
    ok: !args.strike.disabled,
    status,
    providers: page.providers.length,
    allowed,
    exhausted,
    unknownProviders,
    waitResumeOff,
    driftCount: page.drift.length,
    modelOverlapCount: page.modelOverlaps.length,
    earliestReset: page.earliestReset,
    earliestResetIn: resetIn(page.earliestReset, nowMs),
  };
}
