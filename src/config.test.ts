import { describe, expect, it } from "vitest";
import {
  effectiveReservePercent,
  isLiveQuotaEnabled,
  isLoopbackUrl,
  isMetaQuotaEnabled,
  parseConfig,
  stripTrailingSlashes,
} from "./config.js";

function base(over: Record<string, unknown> = {}) {
  return {
    cliproxyBaseUrl: "http://127.0.0.1:8317",
    managementKeyHeader: "X-Test-Key",
    managementSecretRef: { uid: "secret-1" },
    ...over,
  };
}

describe("providers[] rows", () => {
  it("accepts one row per provider with completeInventory defaulting to false", () => {
    const { config, validation } = parseConfig(
      base({
        providers: [
          { provider: "Claude", connectionId: "conn-claude" },
          { provider: "codex", connectionId: "conn-codex", completeInventory: true },
        ],
      }),
    );
    expect(validation.ok).toBe(true);
    expect(config.providers).toEqual([
      { provider: "claude", connectionId: "conn-claude", completeInventory: false },
      { provider: "codex", connectionId: "conn-codex", completeInventory: true },
    ]);
  });

  it("rejects duplicate provider rows", () => {
    const { validation } = parseConfig(
      base({
        providers: [
          { provider: "claude", connectionId: "conn-a" },
          { provider: "claude", connectionId: "conn-b" },
        ],
      }),
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.includes("duplicate provider row"))).toBe(true);
  });

  it("accepts future provider words as-is: openrouter gets its own row with no code change", () => {
    const { config, validation } = parseConfig(
      base({
        providers: [
          { provider: "claude", connectionId: "conn-a" },
          { provider: "openrouter", connectionId: "conn-openrouter" },
          { provider: "cloudflare-workers-ai", connectionId: "conn-cf" },
        ],
      }),
    );
    expect(validation.ok).toBe(true);
    expect(config.providers).toEqual([
      { provider: "claude", connectionId: "conn-a", completeInventory: false },
      { provider: "openrouter", connectionId: "conn-openrouter", completeInventory: false },
      { provider: "cloudflare-workers-ai", connectionId: "conn-cf", completeInventory: false },
    ]);
  });

  it("warns on empty providers and rejects a leftover v1 prefixMap loudly", () => {
    const empty = parseConfig(base({ providers: [] }));
    expect(empty.validation.ok).toBe(true);
    expect(empty.validation.warnings.some((w) => w.includes("providers is empty"))).toBe(true);

    const legacy = parseConfig(base({ prefixMap: { "acct-claude-1": "conn-a" } }));
    expect(legacy.validation.ok).toBe(false);
    expect(legacy.validation.errors.some((e) => e.includes("prefixMap was removed"))).toBe(true);
  });

  it("validates pluginQuotaIds as single path segments keyed by provider", () => {
    const bad = parseConfig(base({ pluginQuotaIds: { claude: "quota/with/slash" } }));
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.errors.some((e) => e.includes("single path segment"))).toBe(true);
    const good = parseConfig(base({ pluginQuotaIds: { Claude: "claude-quota" } }));
    expect(good.validation.ok).toBe(true);
    expect(good.config.pluginQuotaIds).toEqual({ claude: "claude-quota" });
  });
});

describe("apiCallEnabled kill switch", () => {
  it("defaults live quota on for antigravity/devin/meta and off for the rest", () => {
    const { config, validation } = parseConfig(base({ providers: [] }));
    expect(validation.ok).toBe(true);
    expect(config.apiCallEnabled).toEqual({});
    for (const provider of ["antigravity", "devin", "meta", " Antigravity "]) {
      expect(isLiveQuotaEnabled(config, provider)).toBe(true);
    }
    for (const provider of ["claude", "codex", "gemini", "openrouter", ""]) {
      expect(isLiveQuotaEnabled(config, provider)).toBe(false);
    }
  });

  it("accepts explicit per-provider booleans (lowercased) and rejects the rest", () => {
    const good = parseConfig(
      base({ providers: [], apiCallEnabled: { Antigravity: false, DEVIN: true } }),
    );
    expect(good.validation.ok).toBe(true);
    expect(good.config.apiCallEnabled).toEqual({ antigravity: false, devin: true });
    expect(isLiveQuotaEnabled(good.config, "antigravity")).toBe(false);
    expect(isLiveQuotaEnabled(good.config, "devin")).toBe(true);
    expect(isLiveQuotaEnabled(good.config, "meta")).toBe(true);

    const bad = parseConfig(base({ providers: [], apiCallEnabled: { antigravity: "no" } }));
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.errors.some((e) => e.includes("apiCallEnabled"))).toBe(true);

    const notObject = parseConfig(base({ providers: [], apiCallEnabled: true }));
    expect(notObject.validation.ok).toBe(false);
  });

  it("trims padded provider keys so the kill switch cannot silently miss", () => {
    const padded = parseConfig(
      base({ providers: [], apiCallEnabled: { " Antigravity ": false } }),
    );
    expect(padded.validation.ok).toBe(true);
    expect(padded.config.apiCallEnabled).toEqual({ antigravity: false });
    expect(isLiveQuotaEnabled(padded.config, "antigravity")).toBe(false);
  });
});

describe("metaQuota toggle (Meta download + key call)", () => {
  it("defaults enabled so Meta live quota runs out of the box", () => {
    const { config, validation } = parseConfig(base({ providers: [] }));
    expect(validation.ok).toBe(true);
    expect(config.metaQuota).toEqual({ enabled: true });
    expect(isMetaQuotaEnabled(config)).toBe(true);
  });

  it("accepts an explicit false and then Meta live quota stays off", () => {
    const off = parseConfig(base({ providers: [], metaQuota: { enabled: false } }));
    expect(off.validation.ok).toBe(true);
    expect(off.config.metaQuota).toEqual({ enabled: false });
    expect(isMetaQuotaEnabled(off.config)).toBe(false);
  });

  it("stays off when either switch disagrees (both must agree)", () => {
    // metaQuota on but the family kill switch off: off wins.
    const killed = parseConfig(
      base({ providers: [], metaQuota: { enabled: true }, apiCallEnabled: { meta: false } }),
    );
    expect(killed.validation.ok).toBe(true);
    expect(isMetaQuotaEnabled(killed.config)).toBe(false);
    // Family kill switch on but metaQuota off: still off.
    const toggled = parseConfig(
      base({ providers: [], metaQuota: { enabled: false }, apiCallEnabled: { meta: true } }),
    );
    expect(toggled.validation.ok).toBe(true);
    expect(isMetaQuotaEnabled(toggled.config)).toBe(false);
  });

  it("rejects non-object and non-boolean shapes loudly", () => {
    for (const metaQuota of [true, "no", { enabled: "no" }, { enabled: 1 }]) {
      const bad = parseConfig(base({ providers: [], metaQuota }));
      expect(bad.validation.ok).toBe(false);
      expect(bad.validation.errors.some((e) => e.includes("metaQuota"))).toBe(true);
    }
  });
});

describe("ignored drift acceptance (ignoredProviders / ignoredAuthFileRefs)", () => {
  it("defaults both lists to empty", () => {
    const { config, validation } = parseConfig(base({ providers: [] }));
    expect(validation.ok).toBe(true);
    expect(config.ignoredProviders).toEqual([]);
    expect(config.ignoredAuthFileRefs).toEqual([]);
  });

  it("normalises providers to lowercase and dedupes with a warning", () => {
    const { config, validation } = parseConfig(
      base({ providers: [], ignoredProviders: [" OpenRouter ", "openrouter", "XAI"] }),
    );
    expect(validation.ok).toBe(true);
    expect(config.ignoredProviders).toEqual(["openrouter", "xai"]);
    expect(validation.warnings.some((w) => w.includes("ignoredProviders"))).toBe(true);
  });

  it("accepts the full page ref and the bare hash, normalised to 8-hex", () => {
    const { config, validation } = parseConfig(
      base({ providers: [], ignoredAuthFileRefs: ["auth file C246E171", "6d6f6b47"] }),
    );
    expect(validation.ok).toBe(true);
    expect(config.ignoredAuthFileRefs).toEqual(["c246e171", "6d6f6b47"]);
  });

  it("dedupes refs across both spellings with a warning", () => {
    const { config, validation } = parseConfig(
      base({ providers: [], ignoredAuthFileRefs: ["auth file c246e171", "c246e171"] }),
    );
    expect(validation.ok).toBe(true);
    expect(config.ignoredAuthFileRefs).toEqual(["c246e171"]);
    expect(validation.warnings.some((w) => w.includes("ignoredAuthFileRefs"))).toBe(true);
  });

  it("rejects non-lists, empty entries and non-hash refs loudly", () => {
    for (const bad of [
      { ignoredProviders: "openrouter" },
      { ignoredProviders: [""] },
      { ignoredProviders: [42] },
      { ignoredAuthFileRefs: "auth file c246e171" },
      { ignoredAuthFileRefs: [""] },
      { ignoredAuthFileRefs: ["auth file c246e17"] },
      { ignoredAuthFileRefs: ["c246e17g"] },
      { ignoredAuthFileRefs: ["auth file not-a-hash-at-all"] },
    ]) {
      const { validation } = parseConfig(base({ providers: [], ...bad }));
      expect(validation.ok).toBe(false);
    }
  });
});

describe("providerWindows overrides", () => {
  it("warns when a codex override drops the stock primary/secondary windows", () => {
    // Operator overrides replace the defaults: ["5h", "weekly"] alone stops
    // gating stock x-codex-primary-* / x-codex-secondary-* quota. ["codex"]
    // looks covering but gates nothing either: gating is decided on the bare
    // window names ("primary"), which do not contain "codex".
    for (const windows of [["5h", "weekly"], ["codex"]]) {
      const { validation } = parseConfig(base({ providerWindows: { codex: windows } }));
      expect(validation.ok).toBe(true);
      expect(validation.warnings.some((w) => w.includes("primary/secondary"))).toBe(true);
    }
  });

  it("stays quiet when a codex override still gates the stock windows", () => {
    for (const windows of [["primary", "secondary"], ["5h", "primary", "weekly", "secondary"]]) {
      const { validation } = parseConfig(base({ providerWindows: { codex: windows } }));
      expect(validation.warnings.some((w) => w.includes("primary/secondary"))).toBe(false);
    }
  });
});

describe("client API key secret_ref (/v1/models derivation)", () => {
  it("warns (but stays valid) when the client secret is missing", () => {
    const { config, validation } = parseConfig(base({ providers: [] }));
    expect(validation.ok).toBe(true);
    expect(config.clientApiKeySecretRef).toBeNull();
    expect(validation.warnings.some((w) => w.includes("clientApiKeySecretRef"))).toBe(true);
  });

  it("accepts a secret_ref object and rejects legacy string UUIDs", () => {
    const good = parseConfig(base({ clientApiKeySecretRef: { uid: "secret-client-1" } }));
    expect(good.validation.ok).toBe(true);
    expect(good.config.clientApiKeySecretRef).toEqual({ uid: "secret-client-1" });
    const bad = parseConfig(base({ clientApiKeySecretRef: "legacy-uuid" }));
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.errors.some((e) => e.includes("clientApiKeySecretRef"))).toBe(true);
  });
});

describe("read-model keys (OpenRouter spend, request counts)", () => {
  it("leaves both unset by default: spend reads as not configured, counts stay off", () => {
    const { config, validation } = parseConfig(base());
    expect(validation.ok).toBe(true);
    expect(config.openRouterSecretRef).toBeNull();
    expect(config.apiKeyUsageEnabled).toBe(false);
  });

  it("accepts a dedicated OpenRouter secret_ref object; legacy strings fail closed", () => {
    const good = parseConfig(base({ openRouterSecretRef: { uid: "secret-or-1" } }));
    expect(good.validation.ok).toBe(true);
    expect(good.config.openRouterSecretRef).toEqual({ uid: "secret-or-1" });
    const bad = parseConfig(base({ openRouterSecretRef: "legacy-uuid" }));
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.errors.some((e) => e.includes("openRouterSecretRef"))).toBe(true);
  });

  it("accepts apiKeyUsageEnabled true; non-booleans fail closed", () => {
    expect(parseConfig(base({ apiKeyUsageEnabled: true })).config.apiKeyUsageEnabled).toBe(true);
    const bad = parseConfig(base({ apiKeyUsageEnabled: "yes" }));
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.errors.some((e) => e.includes("apiKeyUsageEnabled"))).toBe(true);
  });
});

describe("security knobs (kept from v1)", () => {
  it("requires loopback base URL, explicit key header, and secret_ref object", () => {
    expect(parseConfig(base({ cliproxyBaseUrl: "https://x.example" })).validation.ok).toBe(false);
    expect(parseConfig(base({ managementKeyHeader: "" })).validation.ok).toBe(false);
    expect(parseConfig(base({ managementSecretRef: "legacy-uuid" })).validation.ok).toBe(false);
  });

  it("loopback check covers spellings without opening non-loopback hosts", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8317")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8317")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8317")).toBe(true);
    expect(isLoopbackUrl("https://cliproxy.example.com")).toBe(false);
    expect(isLoopbackUrl("http://21370.example.com")).toBe(false);
  });
});

describe("stripTrailingSlashes (non-regex trailing-slash trim)", () => {
  it("strips trailing slashes without a regex", () => {
    expect(stripTrailingSlashes("http://127.0.0.1:8317///")).toBe("http://127.0.0.1:8317");
  });
});

describe("reserve math (kept from v1)", () => {
  it("pool thresholdPercent derives 100 - t; per-pool override wins", () => {
    const { config } = parseConfig(base({ reservePercent: 10, perPoolReservePercent: { "pool-x": 25 } }));
    expect(effectiveReservePercent(config, { id: "pool-x", thresholdPercent: 90 })).toBe(25);
    expect(effectiveReservePercent(config, { id: "other", thresholdPercent: 90 })).toBe(10);
    expect(effectiveReservePercent(config, {})).toBe(10);
  });
});

describe("live provider-API window defaults", () => {
  it("gates the meta window/weekly and antigravity time windows the live parsers emit", async () => {
    const { DEFAULT_PROVIDER_WINDOWS } = await import("./config.js");
    const { isGatingWindow } = await import("./parsers.js");
    expect(isGatingWindow("meta", "window", DEFAULT_PROVIDER_WINDOWS.meta as string[])).toBe(true);
    expect(isGatingWindow("meta", "weekly", DEFAULT_PROVIDER_WINDOWS.meta as string[])).toBe(true);
    for (const w of ["weekly", "5h"]) {
      expect(isGatingWindow("antigravity", w, DEFAULT_PROVIDER_WINDOWS.antigravity as string[])).toBe(true);
    }
    // Devin live-RPC windows keep gating as before.
    for (const w of ["daily", "weekly"]) {
      expect(isGatingWindow("devin", w, DEFAULT_PROVIDER_WINDOWS.devin as string[])).toBe(true);
    }
  });
});

describe("showAccountEmails opt-in (account labels)", () => {
  it("defaults to false and accepts an explicit boolean", () => {
    expect(parseConfig(base({})).config.showAccountEmails).toBe(false);
    expect(parseConfig(base({ showAccountEmails: true })).config.showAccountEmails).toBe(true);
    expect(parseConfig(base({ showAccountEmails: true })).validation.ok).toBe(true);
  });

  it("rejects non-boolean values", () => {
    expect(parseConfig(base({ showAccountEmails: "yes" })).validation.ok).toBe(false);
  });
});
