import { createElement, useCallback, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPageProps, PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { CliProxyPage, CliProxyUsagePage, CliProxyWidget } from "../ui/index.js";
import { DEFAULT_PROVIDER_WINDOWS, maxAgeMs, parseConfig } from "./config.js";
import { parseAuthFiles } from "./parsers.js";
import { aggregateProvider } from "./aggregate.js";
import { buildPageData, buildUsageData, buildWidgetData } from "./ui-data.js";
import { emptyStrikeBudget } from "./sync.js";
import type { AccountUsageRow } from "./types.js";

const sdk = vi.hoisted(() => ({ read: vi.fn(), action: vi.fn(), calls: vi.fn(), delay: 0 }));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: (key: string, params: { companyId: string | null }) => {
    const [data, setData] = useState(() => sdk.read(key, params));
    const [loading, setLoading] = useState(false);
    // Deliberately new identity on every render, as a host hook may return.
    return { data, loading, error: null, refresh: () => {
      sdk.calls(key, params);
      setLoading(true);
      const finish = () => { setData(sdk.read(key, params)); setLoading(false); };
      if (sdk.delay) setTimeout(finish, sdk.delay);
      else finish();
    } };
  },
  usePluginAction: () => useCallback(sdk.action, []),
}));

const NOW = Date.parse("2026-11-08T02:00:00Z");
const context = { companyId: "company-a" } as PluginPageProps["context"];
const components = [CliProxyPage, CliProxyUsagePage] as const;
let view: ReactTestRenderer | undefined;

function fixture(kind: "credit" | "reset" | "retry") {
  const { config, validation } = parseConfig({
    cliproxyBaseUrl: "http://127.0.0.1:8317", managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" }, audienceConfirmed: true,
    providers: [{ provider: "codex", connectionId: "conn-codex", completeInventory: true,
      creditsCountAsHeadroom: kind === "credit" }],
  });
  expect(validation.ok).toBe(true);
  const iso = (ms: number) => new Date(ms).toISOString();
  const row: AccountUsageRow = {
    key: "acct-aaa", provider: "codex", channel: "codex", status: "active",
    statusMessage: null, priority: null, planType: null, checkedAt: iso(NOW),
    source: "plugin:cliproxy-connector", quotaBlind: false, accountHash: "hash-aaa",
    lastError: null, coolingDown: kind === "retry",
    cooldownUntil: kind === "retry" ? iso(NOW + 15_000) : null,
    limits: [{ id: "codex:primary", label: "Codex primary", usedPercent: 100,
      remainingPercent: 0, resetsAt: kind === "reset" ? iso(NOW + 15_000) : null,
      limitReached: true, allowed: false, gating: true, observedAt: iso(NOW), models: null }],
    credits: kind === "credit" ? { hasCredits: true, unlimited: false, balance: 5,
      observedAt: iso(NOW - maxAgeMs(config) + 15_000) } : null,
  };
  const args = () => ({ now: iso(Date.now()), config, rows: { [row.key]: row },
    lastSync: null, strike: emptyStrikeBudget() });
  sdk.read.mockImplementation((key: string) => key === "cliproxy-usage" ? buildUsageData(args())
    : key === "cliproxy-widget" ? buildWidgetData(args()) : buildPageData(args()));
  return { row, config, iso };
}

function text() { return JSON.stringify(view?.toJSON()); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  sdk.delay = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (view) await act(async () => view?.unmount());
  view = undefined;
  vi.useRealTimers();
});

for (const Component of components) {
  describe(`${Component.name} persistent cache lifecycle`, () => {
    for (const kind of ["credit", "reset", "retry"] as const) {
      it(`automatically expires ${kind} and recovers without reload, resync or fixture reads`, async () => {
        const { row, config, iso } = fixture(kind);
        await act(async () => { view = create(createElement(Component, { context })); });
        expect(text()).toContain(kind === "credit" ? '"allowed"' : '"exhausted"');
        const mountReads = sdk.read.mock.calls.length;
        // The boundary passes with no worker/fixture read to mask expiry.
        await act(async () => { vi.advanceTimersByTime(16_000); });
        expect(sdk.read).toHaveBeenCalledTimes(mountReads);
        await act(async () => { vi.advanceTimersByTime(14_000); });
        const verdict = aggregateProvider({ config, provider: "codex", rows: [row],
          completeInventory: true, model: null, now: iso(Date.now()), creditsCountAsHeadroom: kind === "credit" });
        expect(verdict.state).toBe("unknown");
        expect(verdict.headroomAccounts).toBe(0);
        expect(text()).toContain('"unknown"');
        expect(sdk.read.mock.results.at(-1)?.value.providers[0]).toMatchObject({
          state: verdict.state, headroomAccounts: 0, creditHeadroomAccounts: 0,
        });
        expect(sdk.calls).toHaveBeenCalledTimes(1);
        // Background sync updates the cache only; the page stays mounted.
        row.checkedAt = iso(Date.now());
        row.coolingDown = false;
        row.cooldownUntil = null;
        if (kind !== "credit") row.limits = row.limits.map((limit) => ({ ...limit,
          usedPercent: 20, remainingPercent: 80, limitReached: false, allowed: true,
          observedAt: row.checkedAt, resetsAt: null }));
        if (row.credits) row.credits.observedAt = row.checkedAt;
        const readsAtSync = sdk.read.mock.calls.length;
        await act(async () => { vi.advanceTimersByTime(29_000); });
        expect(sdk.read).toHaveBeenCalledTimes(readsAtSync);
        await act(async () => { vi.advanceTimersByTime(1_000); });
        expect(text()).toContain('"allowed"');
        expect(text()).not.toContain('"unknown"');
        expect(text()).toContain(row.checkedAt);
        expect(sdk.calls).toHaveBeenCalledTimes(2);
        expect(sdk.action).not.toHaveBeenCalled();
      });
    }

    it("reconciles scoped Hopper rows and account-wide guards through automatic refresh", async () => {
      const { config } = parseConfig({
        cliproxyBaseUrl: "http://127.0.0.1:8317", managementKeyHeader: "X-Test-Key",
        managementSecretRef: { uid: "secret-1" }, audienceConfirmed: true,
        providers: [{ provider: "hopper", connectionId: "conn-hopper", completeInventory: true }],
      });
      const feature = { window: "5h", scope: "feature", description: "Feature quota", remainingFraction: 0.4 };
      const weekly = { window: "weekly", description: "Weekly quota", remainingFraction: 0.8 };
      let buckets: Record<string, unknown>[] = [feature, weekly];
      sdk.read.mockImplementation((key: string) => {
        const now = new Date(Date.now()).toISOString();
        const row = parseAuthFiles({ files: [{ id: "hopper", provider: "hopper", auth_index: "h" }] }, {
          now, allowLists: DEFAULT_PROVIDER_WINDOWS,
          pluginPayloadByAuthIndex: new Map([["h", { groups: [{ buckets }] }]]),
        }).accounts[0];
        const args = { now, config, rows: { [row.key]: row }, lastSync: null, strike: emptyStrikeBudget() };
        return key === "cliproxy-usage" ? buildUsageData(args) : buildPageData(args);
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await act(async () => { view = create(createElement(Component, { context })); });
        const projected = () => sdk.read.mock.results.at(-1)!.value.providers[0];
        const quotaRows = () => view!.root.findAll((node) =>
          node.type === (Component === CliProxyPage ? "li" : "div") &&
          typeof node.props.title === "undefined" &&
          (Component === CliProxyPage
            ? typeof node.children[0] === "string" && ["Feature quota", "Weekly quota", "hopper 5h", "Account quota"].includes(node.children[0])
            : typeof node.children[0] === "object" && node.children[0]?.props.label !== undefined));
        expect(projected()).toMatchObject({ state: "unknown", headroomAccounts: 0 });
        expect(projected().accounts[0].limits).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "hopper:5h", gating: false, remainingPercent: 40 }),
          expect.objectContaining({ id: "hopper:5h", gating: true, remainingPercent: null }),
        ]));
        expect(quotaRows()).toHaveLength(3);
        const featureNode = quotaRows()[0];
        const weeklyNode = quotaRows()[1];
        const guardNode = quotaRows()[2];
        // Reordering the source must retain the identities of unrelated scopes.
        buckets = [weekly, feature];
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(quotaRows()).toEqual([weeklyNode, featureNode, guardNode]);
        // Real account-wide evidence replaces the guard, not the feature observation.
        buckets = [weekly, { window: "5h", description: "Account quota", remainingFraction: 0.6 }, feature];
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(projected()).toMatchObject({ state: "allowed", headroomAccounts: 1 });
        expect(quotaRows()).toEqual([weeklyNode, guardNode, featureNode]);
        expect(quotaRows()).toHaveLength(3);
        expect(text()).not.toContain('"hopper 5h"');
        expect(text()).toContain('"Account quota"');
        // Removing scoped evidence leaves exactly the two account windows.
        buckets = [weekly, { window: "5h", description: "Account quota", remainingFraction: 0.7 }];
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(quotaRows()).toEqual([weeklyNode, guardNode]);
        expect(text()).not.toContain('"Feature quota"');
        expect(sdk.calls).toHaveBeenCalledTimes(3);
        expect(sdk.action).not.toHaveBeenCalled();
        expect(errors.mock.calls.filter((args) => /same key|unique.*key/i.test(args.join(" ")))).toEqual([]);
      } finally {
        errors.mockRestore();
      }
    });

    it("does not supersede a slow read or unmount existing content while refreshing", async () => {
      fixture("credit");
      sdk.delay = 35_000;
      await act(async () => { view = create(createElement(Component, { context })); });
      const rendered = view!.root.findAllByType("div").find((node) => node.props.style?.display === "grid");
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(sdk.calls).toHaveBeenCalledTimes(1);
      expect(view!.root.findAllByType("div")).toContain(rendered);
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(sdk.calls).toHaveBeenCalledTimes(1);
      expect(view!.root.findAllByType("div")).toContain(rendered);
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(text()).toContain('"unknown"');
      await act(async () => { vi.advanceTimersByTime(25_000); });
      expect(sdk.calls).toHaveBeenCalledTimes(2);
      await act(async () => { vi.advanceTimersByTime(35_000); });
      expect(sdk.action).not.toHaveBeenCalled();
    });

    it("bounds reads and cleans up its timer on unmount", async () => {
      fixture("credit");
      await act(async () => { view = create(createElement(Component, { context })); });
      for (let i = 0; i < 4; i++) {
        await act(async () => { vi.advanceTimersByTime(30_000); });
      }
      expect(sdk.calls).toHaveBeenCalledTimes(4);
      await act(async () => view?.unmount());
      vi.advanceTimersByTime(120_000);
      expect(sdk.calls).toHaveBeenCalledTimes(4);
      view = undefined;
    });

    it("uses the current company callback and restarts the timer on a company change", async () => {
      fixture("credit");
      await act(async () => { view = create(createElement(Component, { context })); });
      await act(async () => { vi.advanceTimersByTime(15_000); });
      await act(async () => { view?.update(createElement(Component,
        { context: { ...context, companyId: "company-b" } })); });
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(sdk.calls).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(sdk.calls).toHaveBeenCalledExactlyOnceWith(expect.any(String), { companyId: "company-b" });
    });

    it("does not schedule cache reads without company context", async () => {
      fixture("credit");
      await act(async () => { view = create(createElement(Component,
        { context: { ...context, companyId: null } })); });
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(sdk.calls).not.toHaveBeenCalled();
    });
  });
}

it("automatically updates the widget's provider counts after expiry and recovery", async () => {
  const { row, iso } = fixture("credit");
  await act(async () => { view = create(createElement(CliProxyWidget,
    { context: context as PluginWidgetProps["context"] })); });
  expect(text()).toContain('1');
  await act(async () => { vi.advanceTimersByTime(30_000); });
  const refreshed = sdk.read.mock.results.at(-1)?.value;
  expect(refreshed).toMatchObject({ allowed: 0, unknownProviders: 1 });
  row.checkedAt = iso(Date.now());
  if (row.credits) row.credits.observedAt = row.checkedAt;
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(sdk.read.mock.results.at(-1)?.value).toMatchObject({ allowed: 1, unknownProviders: 0 });
  expect(sdk.action).not.toHaveBeenCalled();
});
