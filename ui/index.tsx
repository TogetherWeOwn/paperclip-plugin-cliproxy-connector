/**
 * CLIProxy Connector UI: plugin page + dashboard widget (v2, per-provider).
 *
 * Runs in the host frontend as an ES module bundle (see `npm run build:ui`).
 * All data comes from the worker (`cliproxy-page` / `cliproxy-widget`);
 * actions (`cliproxy-resync`, `cliproxy-reenable`) run worker-side.
 * This bundle never sees the management key.
 */
import { useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type {
  PluginPageProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type { PageData, ProviderAccountDetail, UsagePageData, WidgetData } from "../src/ui-data.js";

function useCompanyId(context: PluginPageProps["context"]): string | null {
  return context.companyId;
}

function FreshnessBadge({ freshness }: { freshness: string }) {
  const tone =
    freshness === "fresh"
      ? { background: "#14532d", color: "#bbf7d0" }
      : freshness === "stale"
        ? { background: "#78350f", color: "#fde68a" }
        : { background: "#7f1d1d", color: "#fecaca" };
  return <span style={{ ...tone, borderRadius: 4, padding: "1px 6px", fontSize: 12 }}>{freshness}</span>;
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "allowed"
      ? { background: "#14532d", color: "#bbf7d0" }
      : state === "exhausted"
        ? { background: "#7f1d1d", color: "#fecaca" }
        : { background: "#78350f", color: "#fde68a" };
  return <span style={{ ...tone, borderRadius: 4, padding: "1px 6px", fontSize: 12 }}>{state}</span>;
}

export function CliProxyPage({ context }: PluginPageProps) {
  const companyId = useCompanyId(context);
  const { data, loading, error, refresh } = usePluginData<PageData>("cliproxy-page", { companyId });
  const resync = usePluginAction("cliproxy-resync");
  const reenable = usePluginAction("cliproxy-reenable");

  if (!companyId) return <div>No company context.</div>;
  if (loading) return <div>Loading CLIProxy provider state…</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return <div>No data yet — run a sync.</div>;

  return (
    <div style={{ display: "grid", gap: 16, padding: 16 }}>
      {!data.audienceConfirmed && (
        <div style={{ background: "#78350f", color: "#fde68a", padding: 12, borderRadius: 6 }}>
          {data.audienceNotice}
        </div>
      )}
      {data.strike.disabled && (
        <div style={{ background: "#7f1d1d", color: "#fecaca", padding: 12, borderRadius: 6 }}>
          <strong>Sync hard-disabled</strong> since {data.strike.disabledAt}: {data.strike.disabledReason}{" "}
          {data.strike.waitUntil && (
            <span>
              No probe will be sent until {data.strike.waitUntil} — re-enabling before then keeps sync paused.{" "}
            </span>
          )}
          <button
            onClick={async () => {
              await reenable({ companyId });
              refresh();
            }}
          >
            Re-enable (board action)
          </button>
        </div>
      )}
      {!data.strike.disabled && data.strike.secretBad && (
        <div style={{ background: "#78350f", color: "#fde68a", padding: 12, borderRadius: 6 }}>
          <strong>Management key rejected by CLIProxy.</strong> Sync is paused and no further probes will be sent.{" "}
          Rotate the key, then{" "}
          <button
            onClick={async () => {
              await reenable({ companyId });
              refresh();
            }}
          >
            Re-enable (board action)
          </button>
        </div>
      )}
      <div>
        <strong>Sync:</strong> {data.sync.ranAt ? `last run ${data.sync.ranAt}` : "never ran"} ·{" "}
        {data.sync.accountsSeen} accounts, {data.sync.rowsWritten} rows ·{" "}
        {data.sync.skipped ? `skipped: ${data.sync.skipReason}` : "ok"}
        {data.sync.errors.length > 0 && (
          <ul>
            {data.sync.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}{" "}
        <button
          onClick={async () => {
            await resync({ companyId });
            refresh();
          }}
        >
          Sync now
        </button>
      </div>
      {data.earliestReset && <div>Earliest known reset: {data.earliestReset}</div>}
      {data.modelsNote && (
        <div style={{ background: "#78350f", color: "#fde68a", padding: 12, borderRadius: 6 }}>
          Model catalog unavailable: {data.modelsNote} Overlap detection is off until the next successful
          catalog fetch.
        </div>
      )}
      {data.modelOverlaps.length > 0 && (
        <div style={{ background: "#78350f", color: "#fde68a", padding: 12, borderRadius: 6 }}>
          <strong>Overlapping models ({data.modelOverlaps.length})</strong> — served by more than one
          provider, proven for none:
          <ul>
            {data.modelOverlaps.map((o) => (
              <li key={o.id}>
                <code>{o.id}</code>: {o.providers.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.drift.length > 0 && (
        <div>
          <strong>Drift findings ({data.drift.length})</strong>
          <ul>
            {data.drift.map((d) => (
              <li key={`${d.kind}:${d.provider}:${d.detail}`}>
                [{d.kind}] {d.provider}: {d.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.accepted.length > 0 && (
        <div>
          <strong>Accepted findings ({data.accepted.length})</strong> — explicitly accepted in
          config, not alerted:
          <ul>
            {data.accepted.map((d) => (
              <li key={`${d.kind}:${d.provider}:${d.detail}`}>
                [{d.kind}] {d.provider}: {d.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.providers.map((p) => (
        <div key={p.provider} style={{ border: "1px solid #444", borderRadius: 6, padding: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <strong>{p.provider}</strong>
            <StateBadge state={p.state} />
            <FreshnessBadge freshness={p.freshness} />
            {p.waitResumeOff && <span>wait/resume off: inventory not confirmed complete</span>}
          </div>
          <div>
            connection {p.connectionId} · completeInventory {p.completeInventory ? "confirmed" : "not confirmed"} ·{" "}
            {p.enabledAccounts} enabled account{p.enabledAccounts === 1 ? "" : "s"}
            {p.headroomAccounts > 0 ? `, ${p.headroomAccounts} with headroom` : ""}
            {p.retryAt ? ` · retry ${p.retryAt} (${p.retryIn})` : ""}
          </div>
          <div>
            {p.models.length > 0 ? (
              <span>
                Proven models ({p.models.length}): <code>{p.models.join(", ")}</code>
              </span>
            ) : (
              <span>No proven models yet — unknown until the model catalog confirms them.</span>
            )}
          </div>
          <div>{p.reason}</div>
          {p.accounts.length > 0 && (
            <details>
              <summary>Discovered accounts ({p.accounts.length}, informational)</summary>
              <ul>
                {p.accounts.map((a) => (
                  <li key={a.key}>
                    <code>{a.key}</code> · {a.status}
                    {a.statusMessage ? ` — ${a.statusMessage}` : ""}
                    {a.planType ? ` · plan ${a.planType}` : ""}
                    {a.priority !== null ? ` · priority ${a.priority}` : ""} · checked {a.checkedAt}
                    {a.quotaBlind && " · quota-blind"}
                    {a.coolingDown && ` · cooling down${a.cooldownUntil ? ` until ${a.cooldownUntil}` : ""}`}
                    {a.limits.length > 0 && (
                      <ul>
                        {a.limits.map((l) => (
                          <li key={l.id}>
                            {l.label}: {l.remainingPercent ?? "?"}% remaining
                            {l.resetsAt ? ` · resets ${l.resetsAt} (${l.resetIn})` : " · no reset known"}
                            {!l.gating && " (informational, not gating)"}
                            {l.allowed === false && " · not admitted"}
                            {l.models && l.models.length > 0 && ` · models ${l.models.join(", ")}`}
                          </li>
                        ))}
                      </ul>
                    )}
                    {a.limits.length === 0 && <div>No quota windows — unknown.</div>}
                    {a.lastError && <div>Last note: {a.lastError}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function WindowBar({ label, remaining, resetIn }: { label: string; remaining: number | null; resetIn: string | null }) {
  const pct = remaining === null ? null : Math.max(0, Math.min(100, remaining));
  const tone =
    pct === null
      ? "#57534e"
      : pct <= 0
        ? "#7f1d1d"
        : pct <= 10
          ? "#78350f"
          : "#14532d";
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "2px 0" }}>
      <span style={{ minWidth: 140, fontSize: 12 }}>{label}</span>
      <div style={{ flex: 1, minWidth: 80, height: 10, background: "#292524", borderRadius: 5, overflow: "hidden" }}>
        <div style={{ width: `${pct ?? 0}%`, height: "100%", background: tone, opacity: pct === null ? 0.4 : 1 }} />
      </div>
      <span style={{ minWidth: 120, fontSize: 12 }}>
        {pct === null ? "unknown" : `${Math.round(pct)}% remaining`}
        {resetIn ? ` · resets ${resetIn}` : " · no reset known"}
      </span>
    </div>
  );
}

type UsageSortKey = "remaining" | "reset";

/**
 * "Usage & quota" page: per-provider verdicts plus a filterable, sortable
 * per-account table. All data comes from the already-synced cache
 * (`cliproxy-usage`); this page never triggers a live read, and the worker
 * never calls the destructive usage-queue endpoint.
 *
 * Read-model sections below the provider cards (spend, per-lane request
 * counts, lane map, native cost links) come from the same cache via
 * `cliproxy-usage`. Request counts are request-count fidelity for api-key
 * lanes only (labelled "requests", never tokens); there is no per-lane token
 * split from any lawful read-only source, and OAuth lanes stay invisible.
 */
export function CliProxyUsagePage({ context }: PluginPageProps) {
  const companyId = useCompanyId(context);
  const { data, loading, error, refresh } = usePluginData<UsagePageData>("cliproxy-usage", { companyId });
  const resync = usePluginAction("cliproxy-resync");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [blindOnly, setBlindOnly] = useState<boolean>(false);
  const [sortKey, setSortKey] = useState<UsageSortKey>("remaining");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  if (!companyId) return <div>No company context.</div>;
  if (loading) return <div>Loading usage &amp; quota…</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return <div>No data yet — run a sync.</div>;

  const allAccounts: Array<{ provider: string; account: ProviderAccountDetail }> = data.providers.flatMap((p) =>
    p.accounts.map((account) => ({ provider: p.provider, account })),
  );
  const statuses = [...new Set(allAccounts.map((a) => a.account.status))].sort();
  const filtered = allAccounts.filter(
    ({ provider, account }) =>
      (providerFilter === "all" || provider === providerFilter) &&
      (statusFilter === "all" || account.status === statusFilter) &&
      (!blindOnly || account.quotaBlind),
  );
  const sorted = [...filtered].sort((x, y) => {
    if (sortKey === "remaining") {
      // Unknown last when ascending (worst-first keeps unknowns visible at
      // the exhausted end is wrong: unknowns sort after every known value).
      const xr = x.account.worstRemaining;
      const yr = y.account.worstRemaining;
      if (xr === null && yr === null) return x.account.key.localeCompare(y.account.key);
      if (xr === null) return 1;
      if (yr === null) return -1;
      return sortDir === "asc" ? xr - yr : yr - xr;
    }
    const xt = x.account.nextReset ? Date.parse(x.account.nextReset) : NaN;
    const yt = y.account.nextReset ? Date.parse(y.account.nextReset) : NaN;
    if (Number.isNaN(xt) && Number.isNaN(yt)) return x.account.key.localeCompare(y.account.key);
    if (Number.isNaN(xt)) return 1;
    if (Number.isNaN(yt)) return -1;
    return sortDir === "asc" ? xt - yt : yt - xt;
  });

  return (
    <div style={{ display: "grid", gap: 16, padding: 16 }}>
      {!data.audienceConfirmed && (
        <div style={{ background: "#78350f", color: "#fde68a", padding: 12, borderRadius: 6 }}>
          {data.audienceNotice}
        </div>
      )}
      <div>
        <strong>Sync:</strong> {data.sync.ranAt ? `last run ${data.sync.ranAt}` : "never ran"} ·{" "}
        {data.sync.accountsSeen} accounts, {data.sync.rowsWritten} rows ·{" "}
        {data.sync.skipped ? `skipped: ${data.sync.skipReason}` : "ok"}
        {data.sync.errors.length > 0 && (
          <ul>
            {data.sync.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}{" "}
        <button
          onClick={async () => {
            await resync({ companyId });
            refresh();
          }}
        >
          Sync now
        </button>
      </div>
      {data.earliestReset && (
        <div>
          Earliest known reset: {data.earliestReset} ({data.earliestResetIn})
        </div>
      )}
      {data.quotaFetchedAt && <div>Quota windows fetched {data.quotaFetchedAt}.</div>}
      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 12 }}>
        <strong>Provider spend (OpenRouter)</strong>
        {!data.spend.configured && <div>not configured</div>}
        {data.spend.configured && data.spend.totalCredits === null && <div>No spend data yet — run a sync.</div>}
        {data.spend.configured && data.spend.totalCredits !== null && (
          <div>
            {data.spend.totalCredits} credits · {data.spend.totalUsage ?? "?"} used
            {data.spend.remaining !== null ? ` · ${data.spend.remaining} remaining` : ""}
          </div>
        )}
        {data.spend.fetchedAt && <div>Fetched {data.spend.fetchedAt}.</div>}
        {data.spend.note && <div>{data.spend.note}</div>}
      </div>
      {data.usage.enabled && (
        <div style={{ border: "1px solid #444", borderRadius: 6, padding: 12 }}>
          <strong>Per-lane usage (requests, api-key lanes only)</strong>
          {data.usage.lanes.length === 0 && <div>No request counts yet — run a sync.</div>}
          {data.usage.lanes.map((lane) => (
            <div key={lane.provider}>
              {lane.provider}: {lane.total} requests ({lane.success} ok, {lane.failed} failed)
            </div>
          ))}
          {data.usage.fetchedAt && <div>Fetched {data.usage.fetchedAt}.</div>}
          <div style={{ fontSize: 12 }}>{data.usage.fidelityNote}</div>
          {data.usage.note && <div>{data.usage.note}</div>}
        </div>
      )}
      <div style={{ border: "1px solid #444", borderRadius: 6, padding: 12 }}>
        <strong>Lane map</strong>
        <div style={{ fontSize: 12 }}>{data.laneMap.flag}</div>
        {data.laneMap.lanes.map((lane) => (
          <div key={lane.lane}>
            {lane.lane}: {lane.agents} agents → {lane.provider}/{lane.model}
          </div>
        ))}
        <div>Derived {data.laneMap.derivedAt}.</div>
      </div>
      <div>
        Native cost views: <a href={data.links.costsUrl}>Costs</a> ·{" "}
        <a href={data.links.budgetsUrl}>Budgets</a>
      </div>
      {data.providers.map((p) => (
        <div key={p.provider} style={{ border: "1px solid #444", borderRadius: 6, padding: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <strong>{p.provider}</strong>
            <StateBadge state={p.state} />
            <FreshnessBadge freshness={p.freshness} />
            {p.blindAccounts > 0 && (
              <span style={{ background: "#78350f", color: "#fde68a", borderRadius: 4, padding: "1px 6px", fontSize: 12 }}>
                blind{p.blindReason ? `: ${p.blindReason}` : ""}
              </span>
            )}
            {p.waitResumeOff && <span>wait/resume off: inventory not confirmed complete</span>}
          </div>
          <div>
            {p.headroomAccounts} of {p.enabledAccounts} enabled account{p.enabledAccounts === 1 ? "" : "s"} with
            headroom
            {p.nextReset ? ` · earliest known reset ${p.nextReset} (${p.nextResetIn})` : ""}
            {p.retryAt && p.retryAt !== p.nextReset ? ` · retry ${p.retryAt} (${p.retryIn})` : ""}
            {` · sync ${p.freshness}`}
          </div>
          <div>{p.reason}</div>
        </div>
      ))}
      <div>
        <strong>Accounts ({sorted.length})</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "8px 0" }}>
          <label>
            Provider{" "}
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
              <option value="all">all</option>
              {data.providers.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.provider}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status{" "}
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">all</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={blindOnly} onChange={(e) => setBlindOnly(e.target.checked)} /> blind
            only
          </label>
          <label>
            Sort by{" "}
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as UsageSortKey)}>
              <option value="remaining">remaining %</option>
              <option value="reset">reset</option>
            </select>
          </label>
          <button onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
        </div>
        {sorted.length === 0 && <div>No accounts match the current filters.</div>}
        {sorted.map(({ provider, account: a }) => (
          <div key={a.key} style={{ border: "1px solid #333", borderRadius: 6, padding: 10, margin: "6px 0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code>{a.maskedLabel}</code>
              <span>{provider}</span>
              <span>{a.status}</span>
              {a.quotaBlind && (
                <span
                  style={{ background: "#78350f", color: "#fde68a", borderRadius: 4, padding: "1px 6px", fontSize: 12 }}
                >
                  blind{a.quotaBlindReason ? `: ${a.quotaBlindReason}` : ""}
                </span>
              )}
              {a.planType && <span>plan {a.planType}</span>}
              {a.priority !== null && <span>priority {a.priority}</span>}
              {a.coolingDown && (
                <span>cooling down{a.cooldownUntil ? ` until ${a.cooldownUntil}${a.cooldownIn ? ` (${a.cooldownIn})` : ""}` : ""}</span>
              )}
            </div>
            {a.statusMessage && <div>Note: {a.statusMessage}</div>}
            {a.limits.length === 0 && <div>No quota windows — unknown.</div>}
            {a.limits.map((l) => (
              <div key={l.id}>
                <WindowBar label={l.label} remaining={l.remainingPercent} resetIn={l.resetIn} />
                {!l.gating && <span style={{ fontSize: 12 }}>(informational, not gating)</span>}
                {l.viaProviderApi && <span style={{ fontSize: 12 }}> · via provider API</span>}
                {l.allowed === false && <span style={{ fontSize: 12 }}> · not admitted</span>}
                {l.models && l.models.length > 0 && <span style={{ fontSize: 12 }}> · models {l.models.join(", ")}</span>}
                {l.metrics && l.metrics.length > 0 && (
                  <div style={{ fontSize: 12 }}>
                    {l.metrics.map((m, i) => (
                      <div key={i}>{m}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {a.lastError && <div>Last error: {a.lastError}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CliProxyWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<WidgetData>("cliproxy-widget", {
    companyId: context.companyId,
  });
  if (loading) return <div>Loading…</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return <div>No data.</div>;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <strong>CLIProxy quota: {data.status}</strong>
      <div>
        {data.providers} providers · {data.allowed} allowed · {data.exhausted} exhausted ·{" "}
        {data.unknownProviders} unknown · {data.waitResumeOff} wait/resume off · {data.driftCount} drift
      </div>
      {data.earliestReset && (
        <div>
          Earliest reset {data.earliestReset} ({data.earliestResetIn})
        </div>
      )}
    </div>
  );
}
