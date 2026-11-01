import { describe, expect, it } from "vitest";
import {
  effectiveReservePercent,
  isLoopbackUrl,
  parseConfig,
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

describe("reserve math (kept from v1)", () => {
  it("pool thresholdPercent derives 100 - t; per-pool override wins", () => {
    const { config } = parseConfig(base({ reservePercent: 10, perPoolReservePercent: { "pool-x": 25 } }));
    expect(effectiveReservePercent(config, { id: "pool-x", thresholdPercent: 90 })).toBe(25);
    expect(effectiveReservePercent(config, { id: "other", thresholdPercent: 90 })).toBe(10);
    expect(effectiveReservePercent(config, {})).toBe(10);
  });
});
