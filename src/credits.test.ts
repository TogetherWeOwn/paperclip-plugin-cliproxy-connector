/**
 * TWO-2107: Codex paid credits count as headroom when the provider row opts
 * in with `creditsCountAsHeadroom` (window-exhausted + credits-available).
 */
import { describe, expect, it } from "vitest";
import { aggregateProvider, creditsPositive } from "./aggregate.js";
import { DEFAULT_PROVIDER_WINDOWS, parseConfig, type ConnectorConfig } from "./config.js";
import { parseAuthFiles, parseHeaderSignals } from "./parsers.js";
import type { AccountUsageRow, CreditsReading, UsageLimitRow } from "./types.js";
import { buildUsageData } from "./ui-data.js";

const NOW = "2026-11-03T19:40:00.000Z";
const NOW_MS = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();
const WEEK_RESET = iso(NOW_MS + 11 * 3_600_000);

function config(creditsCountAsHeadroom: boolean | undefined): ConnectorConfig {
  const { config: c, validation } = parseConfig({
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    providers: [
      {
        provider: "codex",
        connectionId: "conn-codex",
        completeInventory: true,
        ...(creditsCountAsHeadroom === undefined ? {} : { creditsCountAsHeadroom }),
      },
    ],
  });
  expect(validation.ok).toBe(true);
  return c;
}

function window(over: Partial<UsageLimitRow> = {}): UsageLimitRow {
  return {
    id: "codex:secondary",
    label: "Codex secondary",
    usedPercent: 100,
    remainingPercent: 0,
    resetsAt: WEEK_RESET,
    limitReached: true,
    allowed: false,
    gating: true,
    observedAt: NOW,
    models: null,
    ...over,
  };
}

function credits(over: Partial<CreditsReading> = {}): CreditsReading {
  return { hasCredits: true, unlimited: false, balance: 42.5, observedAt: NOW, ...over };
}

function row(over: Partial<AccountUsageRow> = {}): AccountUsageRow {
  return {
    key: "acct-codex",
    provider: "codex",
    channel: "codex",
    status: "active",
    statusMessage: null,
    priority: null,
    limits: [window(), window({ id: "codex:primary", label: "Codex primary", resetsAt: iso(NOW_MS + 3_600_000) })],
    planType: "plus",
    checkedAt: NOW,
    source: "plugin:cliproxy-connector",
    quotaBlind: false,
    accountHash: "hash-codex",
    lastError: null,
    coolingDown: false,
    cooldownUntil: null,
    credits: credits(),
    ...over,
  };
}

function assess(rows: AccountUsageRow[], optIn: boolean | undefined, now = NOW) {
  const c = config(optIn);
  return aggregateProvider({
    provider: "codex",
    model: null,
    rows,
    completeInventory: true,
    creditsCountAsHeadroom: c.providers[0]?.creditsCountAsHeadroom,
    config: c,
    now,
  });
}

describe("parseHeaderSignals: Codex credits reading", () => {
  it("reads has-credits, unlimited and balance into the credits reading", () => {
    const parsed = parseHeaderSignals(
      "codex",
      {
        "x-codex-secondary-used-percent": "100",
        "x-codex-secondary-limit-reached": "true",
        "x-codex-credits-has-credits": "True",
        "x-codex-credits-unlimited": "false",
        "x-codex-credits-balance": "42.5",
      },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(parsed.credits).toEqual({ hasCredits: true, unlimited: false, balance: 42.5, observedAt: NOW });
    expect(parsed.limits.map((l) => l.id)).toEqual(["codex:secondary"]);
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps the display-only credits row when has-credits is false", () => {
    const parsed = parseHeaderSignals(
      "codex",
      { "x-codex-credits-has-credits": "false", "x-codex-credits-balance": "0" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(parsed.credits).toMatchObject({ hasCredits: false, balance: 0 });
    expect(parsed.limits).toHaveLength(1);
    expect(parsed.limits[0]).toMatchObject({ id: "codex:credits", limitReached: true, gating: false });
  });

  it("reports no reading when the signals carry no credits headers", () => {
    const parsed = parseHeaderSignals(
      "codex",
      { "x-codex-primary-used-percent": "10" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(parsed.credits).toBeNull();
  });

  it("ignores credits headers for other providers", () => {
    const parsed = parseHeaderSignals(
      "claude",
      { "x-codex-credits-has-credits": "true" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.claude,
    );
    expect(parsed.credits).toBeNull();
  });

  it("rejects an unparseable balance without inventing one", () => {
    const parsed = parseHeaderSignals(
      "codex",
      { "x-codex-credits-has-credits": "true", "x-codex-credits-balance": "lots" },
      NOW,
      DEFAULT_PROVIDER_WINDOWS.codex,
    );
    expect(parsed.credits).toMatchObject({ hasCredits: true, balance: null });
  });
});

describe("parseAuthFiles: credits ride on the account row", () => {
  it("carries the newest reading across account and model observations", () => {
    const older = iso(NOW_MS - 10 * 60_000);
    const { accounts } = parseAuthFiles(
      [
        {
          id: "REDACTED-CODEX-CREDITS",
          provider: "codex",
          quota: {
            observed_at: older,
            signals: { "x-codex-secondary-used-percent": "100", "x-codex-credits-has-credits": "false" },
          },
          model_quotas: {
            "gpt-6.1-sol": {
              observed_at: NOW,
              signals: { "x-codex-credits-has-credits": "true", "x-codex-credits-balance": "12" },
            },
          },
        },
      ],
      { now: NOW, allowLists: DEFAULT_PROVIDER_WINDOWS },
    );
    expect(accounts[0]?.credits).toEqual({ hasCredits: true, unlimited: null, balance: 12, observedAt: NOW });
  });

  it("drops credits on disabled accounts", () => {
    const { accounts } = parseAuthFiles(
      [
        {
          id: "REDACTED-CODEX-OFF",
          provider: "codex",
          disabled: true,
          quota: { observed_at: NOW, signals: { "x-codex-credits-has-credits": "true" } },
        },
      ],
      { now: NOW, allowLists: DEFAULT_PROVIDER_WINDOWS },
    );
    expect(accounts[0]?.credits).toBeNull();
  });
});

describe("creditsPositive", () => {
  it("is true only for a positive or absent balance with has-credits, or unlimited", () => {
    expect(creditsPositive(credits())).toBe(true);
    expect(creditsPositive(credits({ balance: null }))).toBe(true);
    expect(creditsPositive(credits({ balance: 0 }))).toBe(false);
    expect(creditsPositive(credits({ balance: -3 }))).toBe(false);
    expect(creditsPositive(credits({ hasCredits: false }))).toBe(false);
    expect(creditsPositive(credits({ hasCredits: false, unlimited: true }))).toBe(false);
    expect(creditsPositive(credits({ hasCredits: null, unlimited: true, balance: 0 }))).toBe(true);
    expect(creditsPositive(credits({ hasCredits: null, unlimited: null }))).toBe(false);
    expect(creditsPositive(null)).toBe(false);
  });
});

describe("aggregate: window-exhausted plus credits-available", () => {
  it("without the opt-in, exhausted windows stay exhausted whatever the balance", () => {
    for (const optIn of [undefined, false]) {
      const a = assess([row()], optIn);
      expect(a.state).toBe("exhausted");
      expect(a.retryAt).toBe(WEEK_RESET);
      expect(a.creditHeadroomAccounts).toBe(0);
    }
  });

  it("with the opt-in, a fresh positive balance is headroom past exhausted windows", () => {
    const a = assess([row()], true);
    expect(a.state).toBe("allowed");
    expect(a.retryAt).toBeNull();
    expect(a.headroomAccounts).toBe(1);
    expect(a.creditHeadroomAccounts).toBe(1);
    expect(a.reason).toMatch(/paid credits/);
  });

  it("an unlimited reading covers too", () => {
    const a = assess([row({ credits: credits({ hasCredits: null, unlimited: true, balance: null }) })], true);
    expect(a.state).toBe("allowed");
  });

  it("blocks again when credits run out: has-credits false", () => {
    const a = assess([row({ credits: credits({ hasCredits: false, balance: 0 }) })], true);
    expect(a.state).toBe("exhausted");
    expect(a.retryAt).toBe(WEEK_RESET);
  });

  it("blocks again when the balance reads zero", () => {
    const a = assess([row({ credits: credits({ balance: 0 }) })], true);
    expect(a.state).toBe("exhausted");
  });

  it("an account with no credits reading keeps its window verdict", () => {
    const a = assess([row({ credits: null })], true);
    expect(a.state).toBe("exhausted");
  });

  it("a stale credits reading is unknown (fail open), never exhausted", () => {
    const old = iso(NOW_MS - 3 * 3_600_000);
    const a = assess(
      [row({ credits: credits({ observedAt: old }), limits: [window({ observedAt: old })] })],
      true,
    );
    expect(a.state).toBe("unknown");
    expect(a.headroomAccounts).toBe(0);
  });

  it("credits never cover a 429 quota cooldown", () => {
    const cooldownEnd = iso(NOW_MS + 20 * 60_000);
    const a = assess(
      [
        row({
          limits: [
            window(),
            window({ id: "codex:quota-cooldown", label: "quota exhausted (upstream 429)", resetsAt: cooldownEnd }),
          ],
        }),
      ],
      true,
    );
    expect(a.state).toBe("exhausted");
    // The covered weekly window never bounds the wait: only the cooldown does.
    expect(a.retryAt).toBe(cooldownEnd);
  });

  it("credits never cover a retry-after watermark", () => {
    const a = assess(
      [row({ limits: [window(), window({ id: "codex:retry-after", resetsAt: iso(NOW_MS + 60_000) })] })],
      true,
    );
    expect(a.state).toBe("exhausted");
  });

  it("credits never cover an unavailable (cooling) account", () => {
    const a = assess([row({ coolingDown: true, cooldownUntil: iso(NOW_MS + 600_000) })], true);
    expect(a.state).toBe("exhausted");
  });

  it("mixed accounts: one exhausted without credits, one on credits → allowed", () => {
    const a = assess([row({ key: "acct-a", credits: null }), row({ key: "acct-b" })], true);
    expect(a.state).toBe("allowed");
    expect(a.headroomAccounts).toBe(1);
    expect(a.creditHeadroomAccounts).toBe(1);
  });

  it("healthy windows with credits count as plain headroom, not credit headroom", () => {
    const a = assess(
      [row({ limits: [window({ usedPercent: 30, remainingPercent: 70, limitReached: false, allowed: true })] })],
      true,
    );
    expect(a.state).toBe("allowed");
    expect(a.creditHeadroomAccounts).toBe(0);
  });
});

describe("config: creditsCountAsHeadroom", () => {
  it("defaults off and is kept only when true", () => {
    expect(config(undefined).providers[0]).not.toHaveProperty("creditsCountAsHeadroom");
    expect(config(false).providers[0]).not.toHaveProperty("creditsCountAsHeadroom");
    expect(config(true).providers[0]?.creditsCountAsHeadroom).toBe(true);
  });

  it("warns when set on a provider that reports no credits", () => {
    const { config: c, validation } = parseConfig({
      cliproxyBaseUrl: "http://127.0.0.1:8317",
      managementKeyHeader: "X-Test-Key",
      managementSecretRef: { uid: "secret-1" },
      providers: [{ provider: "claude", connectionId: "conn-claude", creditsCountAsHeadroom: true }],
    });
    expect(validation.ok).toBe(true);
    expect(validation.warnings.some((w) => /creditsCountAsHeadroom has no effect/.test(w))).toBe(true);
    expect(c.providers[0]?.creditsCountAsHeadroom).toBe(true);
  });
});

describe("usage page: credit balance and state", () => {
  it("shows the reading per account and the opt-in per provider", () => {
    const usage = buildUsageData({
      now: NOW,
      config: config(true),
      rows: { "acct-codex": row() },
      lastSync: null,
    });
    const codex = usage.providers[0];
    expect(codex).toMatchObject({
      state: "allowed",
      creditsCountAsHeadroom: true,
      creditHeadroomAccounts: 1,
    });
    expect(codex?.accounts[0]?.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 42.5,
      observedAt: NOW,
      positive: true,
    });
  });

  it("shows a run-out reading as not positive, and off by default", () => {
    const usage = buildUsageData({
      now: NOW,
      config: config(undefined),
      rows: { "acct-codex": row({ credits: credits({ hasCredits: false, balance: 0 }) }) },
      lastSync: null,
    });
    const codex = usage.providers[0];
    expect(codex).toMatchObject({ state: "exhausted", creditsCountAsHeadroom: false, creditHeadroomAccounts: 0 });
    expect(codex?.accounts[0]?.credits?.positive).toBe(false);
  });
});
