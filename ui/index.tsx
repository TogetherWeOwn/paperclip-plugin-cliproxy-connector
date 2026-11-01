/**
 * CLIProxy Connector UI: plugin page + dashboard widget (v2, per-provider).
 *
 * Runs in the host frontend as an ES module bundle (see `npm run build:ui`).
 * All data comes from the worker (`cliproxy-page` / `cliproxy-widget`);
 * actions (`cliproxy-resync`, `cliproxy-reenable`) run worker-side.
 * This bundle never sees the management key.
 */
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type {
  PluginPageProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import type { PageData, WidgetData } from "../src/ui-data.js";

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
      {data.drift.length > 0 && (
        <div>
          <strong>Drift findings ({data.drift.length})</strong>
          <ul>
            {data.drift.map((d, i) => (
              <li key={i}>
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
