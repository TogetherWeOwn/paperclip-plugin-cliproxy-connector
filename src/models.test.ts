import { describe, expect, it } from "vitest";
import {
  deriveProviderModels,
  namespaceOfModelId,
  observedModelKeysByProvider,
  parseModelsPayload,
} from "./models.js";

function keysFor(provider: string, models: string[]) {
  return [{ provider, limits: [{ models }] }];
}

describe("parseModelsPayload", () => {
  it("accepts the OpenAI list shape and plain arrays of ids", () => {
    const a = parseModelsPayload({ data: [{ id: "claude-opus-4-5", owned_by: "anthropic" }] });
    expect(a.models).toEqual([{ id: "claude-opus-4-5", ownedBy: "anthropic" }]);
    expect(a.warnings).toEqual([]);
    const b = parseModelsPayload(["devin/claude-opus-4-5"]);
    expect(b.models).toEqual([{ id: "devin/claude-opus-4-5", ownedBy: null }]);
    const c = parseModelsPayload({ models: [{ id: "x", owner: "meta" }] });
    expect(c.models).toEqual([{ id: "x", ownedBy: "meta" }]);
  });

  it("lowercases ids, dedupes repeats, and warns on unusable entries", () => {
    const { models, warnings } = parseModelsPayload({
      data: [{ id: "Claude-Opus-4-5" }, { id: "claude-opus-4-5" }, { nope: 1 }],
    });
    expect(models).toEqual([{ id: "claude-opus-4-5", ownedBy: null }]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("warns on an empty payload instead of claiming models", () => {
    const { models, warnings } = parseModelsPayload({ data: [] });
    expect(models).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("namespaceOfModelId", () => {
  it("splits ns/rest and leaves bare ids alone", () => {
    expect(namespaceOfModelId("devin/claude-opus-4-5")).toBe("devin");
    expect(namespaceOfModelId("synthetic/deepseek-v3")).toBe("synthetic");
    expect(namespaceOfModelId("claude-opus-4-5")).toBeNull();
    expect(namespaceOfModelId("/trailing")).toBeNull();
  });
});

describe("deriveProviderModels", () => {
  it("attributes namespaced ids by namespace, ignoring a misleading owned_by (Devin case)", () => {
    // /v1/models reports owned_by: anthropic for devin/… ids — the quota and
    // the model are still Devin's. Grouping is by namespace here, never by
    // owned_by (the quota grouping in parsers.ts is by auth-file provider
    // for the same reason; see the Devin test there).
    const served = parseModelsPayload({
      data: [{ id: "devin/claude-opus-4-5", owned_by: "anthropic" }],
    }).models;
    const { providerModels, overlaps, warnings } = deriveProviderModels(served, {
      authProviders: ["devin", "claude"],
      observedKeysByProvider: new Map(),
    });
    expect(providerModels.devin).toEqual(["devin/claude-opus-4-5"]);
    expect(providerModels.claude ?? []).not.toContain("devin/claude-opus-4-5");
    expect(overlaps).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("attributes plugin-namespace ids (synthetic/…, nvidia/… → nvidia-nim)", () => {
    const served = parseModelsPayload({
      data: [{ id: "synthetic/deepseek-v3" }, { id: "nvidia/llama-3-3-70b" }],
    }).models;
    const { providerModels } = deriveProviderModels(served, {
      authProviders: ["synthetic", "nvidia-nim"],
      observedKeysByProvider: new Map(),
    });
    expect(providerModels.synthetic).toEqual(["synthetic/deepseek-v3"]);
    expect(providerModels["nvidia-nim"]).toEqual(["nvidia/llama-3-3-70b"]);
  });

  it("attributes a bare id to its single model_quotas claimant", () => {
    const served = parseModelsPayload({ data: [{ id: "claude-sonnet-4-5" }] }).models;
    const { providerModels, overlaps } = deriveProviderModels(served, {
      authProviders: ["claude", "codex"],
      observedKeysByProvider: new Map([["claude", new Set(["claude-sonnet-4-5"])]]),
    });
    expect(providerModels.claude).toEqual(["claude-sonnet-4-5"]);
    expect(overlaps).toEqual([]);
  });

  it("falls back to owned_by for quota-blind providers (Meta bare ids)", () => {
    const served = parseModelsPayload({ data: [{ id: "llama-4-maverick", owned_by: "meta" }] }).models;
    const { providerModels } = deriveProviderModels(served, {
      authProviders: ["meta"],
      observedKeysByProvider: new Map(),
    });
    expect(providerModels.meta).toEqual(["llama-4-maverick"]);
  });

  it("flags a colliding bare id as an overlap, proven for nobody", () => {
    // The likely source: opencode-zen-free's bare ids served for more than
    // one provider family.
    const served = parseModelsPayload({ data: [{ id: "shared-bare-model" }] }).models;
    const { providerModels, overlaps, warnings } = deriveProviderModels(served, {
      authProviders: ["codex", "compat"],
      observedKeysByProvider: new Map([
        ["codex", new Set(["shared-bare-model"])],
        ["compat", new Set(["shared-bare-model"])],
      ]),
    });
    expect(overlaps).toEqual([{ id: "shared-bare-model", providers: ["codex", "compat"] }]);
    expect(providerModels.codex ?? []).not.toContain("shared-bare-model");
    expect(providerModels.compat ?? []).not.toContain("shared-bare-model");
    expect(warnings.some((w) => w.includes("shared-bare-model"))).toBe(true);
  });

  it("an owned_by pointing elsewhere joins the overlap, not a silent steal", () => {
    const served = parseModelsPayload({
      data: [{ id: "shared-bare-model", owned_by: "openai" }],
    }).models;
    const { overlaps } = deriveProviderModels(served, {
      authProviders: ["claude", "codex"],
      observedKeysByProvider: new Map([["claude", new Set(["shared-bare-model"])]]),
    });
    expect(overlaps).toEqual([{ id: "shared-bare-model", providers: ["claude", "codex"] }]);
  });

  it("leaves an unattributable bare id out with a warning, never headroom", () => {
    const served = parseModelsPayload({ data: [{ id: "mystery-model" }] }).models;
    const { providerModels, overlaps, warnings } = deriveProviderModels(served, {
      authProviders: ["claude"],
      observedKeysByProvider: new Map(),
    });
    expect(providerModels).toEqual({});
    expect(overlaps).toEqual([]);
    expect(warnings.some((w) => w.includes("mystery-model"))).toBe(true);
  });
});

describe("observedModelKeysByProvider", () => {
  it("collects model_quotas keys per auth-file provider, skipping account-level windows", () => {
    const byProvider = observedModelKeysByProvider([
      ...keysFor("claude", ["claude-sonnet-4-5"]),
      { provider: "claude", limits: [{ models: null }] },
      ...keysFor("codex", ["gpt-5"]),
    ]);
    expect(byProvider.get("claude")).toEqual(new Set(["claude-sonnet-4-5"]));
    expect(byProvider.get("codex")).toEqual(new Set(["gpt-5"]));
  });
});
