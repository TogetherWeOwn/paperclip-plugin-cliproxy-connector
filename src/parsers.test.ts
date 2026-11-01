import { describe, expect, it } from "vitest";
import {
  hasAdmissionSignal,
  hashIdentity,
  isGatingWindow,
  normalizeProvider,
  parseAuthFiles,
  parsePassiveSignals,
  parsePluginQuota,
  toIsoTimestamp,
} from "./parsers.js";

describe("normalizeProvider", () => {
  it.each([
    ["claude", "claude"],
    ["Anthropic", "claude"],
    ["codex", "codex"],
    ["openai", "codex"],
    ["devin", "devin"],
    ["cognition-devin", "devin"],
    ["meta", "meta"],
    ["antigravity", "antigravity"],
    ["gemini", "antigravity"],
    ["xai", "xai"],
    ["grok", "xai"],
    ["kimi", "kimi"],
    ["moonshot", "kimi"],
    ["opencode", "compat"],
    ["zen", "compat"],
    ["opencode-go", "opencode-go"],
    ["synthetic", "synthetic"],
    ["nvidia-nim", "nvidia-nim"],
    ["nim", "nvidia-nim"],
    ["cloudflare", "cloudflare"],
    ["zai", "zai"],
    ["glm-5", "zai"],
    ["whatever-else", "unknown-provider"],
    ["", "unknown-provider"],
    [null, "unknown-provider"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeProvider(input)).toBe(expected);
  });
});

describe("hasAdmissionSignal", () => {
  it("is true exactly for providers whose observations gate on allowed", () => {
    for (const p of ["claude", "codex", "devin", "synthetic", "cloudflare", "zai", "opencode-go"] as const) {
      expect(hasAdmissionSignal(p)).toBe(true);
    }
    for (const p of ["meta", "antigravity", "xai", "kimi", "compat", "nvidia-nim", "unknown-provider"] as const) {
      expect(hasAdmissionSignal(p)).toBe(false);
    }
  });
});

describe("toIsoTimestamp", () => {
  it("coerces epoch seconds, millis and ISO strings", () => {
    expect(toIsoTimestamp(1_760_000_000)).toBe(new Date(1_760_000_000_000).toISOString());
    expect(toIsoTimestamp(1_760_000_000_000)).toBe(new Date(1_760_000_000_000).toISOString());
    expect(toIsoTimestamp("2026-11-01T12:00:00Z")).toBe("2026-11-01T12:00:00.000Z");
  });

  it("rejects garbage and implausible values", () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp("not a date")).toBeNull();
    expect(toIsoTimestamp(42)).toBeNull();
    expect(toIsoTimestamp(999_999_999_999_999_999)).toBeNull();
  });
});

describe("hashIdentity", () => {
  it("is deterministic and opaque", () => {
    const a = hashIdentity(["id-1", "a@example.com", "claude", "acct-1"]);
    expect(a).toBe(hashIdentity(["id-1", "a@example.com", "claude", "acct-1"]));
    expect(a).not.toContain("a@example.com");
    expect(hashIdentity(["id-2", "a@example.com", "claude", "acct-1"])).not.toBe(a);
    expect(hashIdentity([null, undefined, ""])).toBeNull();
  });
});

describe("isGatingWindow", () => {
  const allow = ["5h", "7d"];
  it("ignores feature-scoped windows, always gates spend-control blocks", () => {
    expect(isGatingWindow("codex", "codex-review", allow, { scope: "code-review" })).toBe(false);
    expect(isGatingWindow("codex", "codex-5h", allow, { scope: "code-review" })).toBe(false);
    expect(isGatingWindow("codex", "something-else", allow, { spendControl: true })).toBe(true);
    expect(isGatingWindow("claude", "claude-5h", allow)).toBe(true);
    expect(isGatingWindow("claude", "claude-monthly", allow)).toBe(false);
  });
});

describe("parsePluginQuota", () => {
  const payload = {
    Subscription: { Plan: "Scale", TierName: "scale" },
    Groups: [
      {
        Buckets: [
          { Window: "5h", RemainingFraction: 0.8, ResetTime: "2026-11-01T17:00:00Z", Description: "5-hour" },
          { Window: "7d", RemainingFraction: 0, ResetTime: "2026-11-08T00:00:00Z" },
        ],
      },
    ],
  };

  it("maps RemainingFraction to percents with reset times", () => {
    const { planType, limits, warnings } = parsePluginQuota("claude", payload, ["5h", "7d"]);
    expect(planType).toBe("Scale");
    expect(warnings).toEqual([]);
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({
      id: "claude:5h",
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: "2026-11-01T17:00:00.000Z",
      limitReached: false,
      allowed: true,
      gating: true,
    });
    expect(limits[1]).toMatchObject({ limitReached: true, allowed: false });
  });

  it("treats non-objects as unknown with a warning, never headroom", () => {
    const r = parsePluginQuota("codex", "garbage", ["codex"]);
    expect(r.limits).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("skips one malformed bucket without blinding the rest (per-window tolerance)", () => {
    const r = parsePluginQuota(
      "codex",
      { Groups: [{ Buckets: [{ Window: "codex-5h" }, { Window: "codex-5h-b", RemainingFraction: 0.5 }] }] },
      ["codex"],
    );
    expect(r.limits).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("marks non-gating windows when softGating (NIM local estimate)", () => {
    const r = parsePluginQuota("nvidia-nim", payload, ["rpm"], { softGating: true });
    expect(r.limits.every((l) => l.gating === false)).toBe(true);
  });
});

describe("parsePassiveSignals", () => {
  it("parses an object-map signal shape with resets", () => {
    const { limits, observedAt, warnings } = parsePassiveSignals(
      "claude",
      {
        observed_at: "2026-11-01T11:55:00Z",
        signals: {
          "5h": { usedPercent: 20, resetAt: "2026-11-01T17:00:00Z" },
          "7d": { usedPercent: 95, resetAt: "2026-11-08T00:00:00Z" },
        },
      } as never,
      ["5h", "7d"],
    );
    expect(warnings).toEqual([]);
    expect(observedAt).toBe("2026-11-01T11:55:00.000Z");
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({ id: "claude:5h", usedPercent: 20, remainingPercent: 80, gating: true });
    expect(limits[1]).toMatchObject({ id: "claude:7d", usedPercent: 95, remainingPercent: 5 });
  });

  it("warns and returns nothing usable when there is no observation", () => {
    const r = parsePassiveSignals("codex", null, ["codex"]);
    expect(r.limits).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("ignores windows with no usable percent", () => {
    const r = parsePassiveSignals("codex", { signals: [{ window: "codex-x", note: "n/a" }] } as never, ["codex"]);
    expect(r.limits).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseAuthFiles", () => {
  const NOW = "2026-11-01T12:00:00.000Z";
  const allowLists = { claude: ["5h"], codex: ["codex"], meta: [] as string[] };

  it("keys entries by prefix and reports unkeyed ones as drift, never trusted", () => {
    const { accounts, unkeyed, warnings } = parseAuthFiles(
      [
        { prefix: "acct-claude-1", channel: "claude", quota: { observed_at: NOW, signals: [] } },
        { channel: "claude", quota: {} },
        { prefix: "has spaces", channel: "claude" },
      ],
      { now: NOW, allowLists },
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].prefix).toBe("acct-claude-1");
    expect(unkeyed).toBe(2);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("marks meta accounts quota-blind (no admission signal, no allow-list)", () => {
    const { accounts } = parseAuthFiles([{ prefix: "acct-meta-1", channel: "meta" }], {
      now: NOW,
      allowLists,
    });
    expect(accounts[0].quotaBlind).toBe(true);
    expect(accounts[0].limits).toEqual([]);
  });

  it("parses each plugin payload with its owning account's provider", () => {
    const { accounts } = parseAuthFiles(
      [
        { prefix: "acct-codex-1", channel: "codex" },
        { prefix: "acct-claude-1", channel: "claude" },
      ],
      {
        now: NOW,
        allowLists,
        pluginPayloadByPrefix: new Map([
          ["acct-codex-1", { Groups: [{ Buckets: [{ Window: "codex-weekly", RemainingFraction: 0.4 }] }] }],
          ["acct-claude-1", { Groups: [{ Buckets: [{ Window: "codex-weekly", RemainingFraction: 0.4 }] }] }],
        ]),
      },
    );
    const codex = accounts.find((a) => a.prefix === "acct-codex-1")!;
    const claude = accounts.find((a) => a.prefix === "acct-claude-1")!;
    // Same window id gates for codex (allow-list match) but not claude.
    expect(codex.limits[0].gating).toBe(true);
    expect(claude.limits[0].gating).toBe(false);
  });

  it("keeps NIM estimates non-gating and quota-blind", () => {
    const { accounts } = parseAuthFiles(
      [{ prefix: "acct-nim-1", channel: "nvidia-nim", quota: { signals: [{ window: "rpm-minute", usedPercent: 10 }] } }],
      { now: NOW, allowLists: { "nvidia-nim": ["rpm"] } },
    );
    expect(accounts[0].quotaBlind).toBe(true);
    expect(accounts[0].limits.every((l) => l.gating === false)).toBe(true);
  });

  it("detects cooldown state with a recovery time", () => {
    const { accounts } = parseAuthFiles(
      [
        {
          prefix: "acct-x-1",
          channel: "xai",
          cooldown: { active: true, next_recover_at: "2026-11-01T14:00:00Z" },
        },
      ],
      { now: NOW, allowLists: {} },
    );
    expect(accounts[0].coolingDown).toBe(true);
    expect(accounts[0].cooldownUntil).toBe("2026-11-01T14:00:00.000Z");
  });

  it("accepts wrapped payload shapes", () => {
    const { accounts } = parseAuthFiles(
      { auth_files: [{ prefix: "a-1", channel: "zai" }] },
      { now: NOW, allowLists: {} },
    );
    expect(accounts).toHaveLength(1);
  });
});
