/**
 * CLIProxy Connector UI: plugin page + dashboard widget.
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

export function CliProxyPage({ context }: PluginPageProps) {
  const companyId = useCompanyId(context);
  const { data, loading, error, refresh } = usePluginData<PageData>("cliproxy-page", { companyId });
  const resync = usePluginAction("cliproxy-resync");
  const reenable = usePluginAction("cliproxy-reenable");

  if (!companyId) return <div>No company context.</div>;
  if (loading) return <div>Loading CLIProxy account state…</div>;
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
                [{d.kind}] {d.prefix}: {d.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.accounts.map((a) => (
        <div key={a.prefix} style={{ border: "1px solid #444", borderRadius: 6, padding: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <strong>{a.prefix}</strong>
            <FreshnessBadge freshness={a.freshness} />
            {a.quotaBlind && <span>quota-blind (unknown, never headroom)</span>}
            {a.coolingDown && <span>cooling down{a.cooldownUntil ? ` until ${a.cooldownUntil}` : ""}</span>}
            {!a.mapped && <span>unmapped — add to prefixMap</span>}
          </div>
          <div>
            provider {a.provider} · plan {a.planType ?? "—"} · connection {a.connectionId ?? "—"} · checked{" "}
            {a.checkedAt}
          </div>
          <ul>
            {a.limits.map((l) => (
              <li key={l.id}>
                {l.label}: {l.remainingPercent ?? "?"}% remaining
                {l.resetsAt ? ` · resets ${l.resetsAt} (${l.resetIn})` : " · no reset known"}
                {!l.gating && " (informational, not gating)"}
                {l.allowed === false && " · not admitted"}
              </li>
            ))}
            {a.limits.length === 0 && <li>No quota windows — unknown.</li>}
          </ul>
          {a.lastError && <div>Last note: {a.lastError}</div>}
          <details>
            <summary>Connection settings (copy-paste for the operator runbook)</summary>
            <pre>{a.connectionSnippet}</pre>
            <div>
              Member profile.model: <code>{a.suggestedProfileModel}</code>
            </div>
          </details>
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
        {data.accounts} accounts · {data.quotaBlind} quota-blind · {data.staleCount} stale · {data.driftCount}{" "}
        drift
      </div>
      {data.earliestReset && (
        <div>
          Earliest reset {data.earliestReset} ({data.earliestResetIn})
        </div>
      )}
    </div>
  );
}
