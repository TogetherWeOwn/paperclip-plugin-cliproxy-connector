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

  it("treats an empty payload as valid evidence for per-file served-set fetches", () => {
    // An empty served set means the credential serves nothing — not the
    // catalog-wide "no provider has proven models" signal.
    const { models, warnings } = parseModelsPayload({ data: [] }, { emptyIsValid: true });
    expect(models).toEqual([]);
    expect(warnings).toEqual([]);
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

  it("resolves an openrouter namespace by exact match with no code change", () => {
    const served = parseModelsPayload({ data: [{ id: "openrouter/deepseek-v3" }] }).models;
    const { providerModels, overlaps, warnings } = deriveProviderModels(served, {
      authProviders: ["openrouter"],
      observedKeysByProvider: new Map(),
    });
    expect(providerModels.openrouter).toEqual(["openrouter/deepseek-v3"]);
    expect(overlaps).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns on a namespace with no in-scope provider instead of guessing", () => {
    const served = parseModelsPayload({ data: [{ id: "mystery-ns/model-x" }] }).models;
    const { providerModels, warnings } = deriveProviderModels(served, {
      authProviders: ["claude"],
      observedKeysByProvider: new Map(),
    });
    expect(providerModels).toEqual({});
    expect(warnings.some((w) => w.includes("mystery-ns"))).toBe(true);
  });

  it("maps owned_by through the explicit vendor table (anthropic → claude)", () => {
    const served = parseModelsPayload({ data: [{ id: "claude-opus-4-5", owned_by: "anthropic" }] }).models;
    const { providerModels } = deriveProviderModels(served, {
      authProviders: ["claude"],
      observedKeysByProvider: new Map(),
    });
    expect(providerModels.claude).toEqual(["claude-opus-4-5"]);
  });

  it("flags the canonical overlap: claude-sonnet-4-6 served by claude and antigravity, antigravity with no model_quotas", () => {
    // The live served set is the evidence antigravity serves the id even
    // though its auth file reports no per-model state for it.
    const served = parseModelsPayload({ data: [{ id: "claude-sonnet-4-6" }] }).models;
    const { providerModels, overlaps, warnings } = deriveProviderModels(served, {
      authProviders: ["claude", "antigravity"],
      observedKeysByProvider: new Map([["claude", new Set(["claude-sonnet-4-6"])]]),
      servedByProvider: new Map([
        ["claude", new Set(["claude-sonnet-4-6"])],
        ["antigravity", new Set(["claude-sonnet-4-6"])],
      ]),
    });
    expect(overlaps).toEqual([{ id: "claude-sonnet-4-6", providers: ["antigravity", "claude"] }]);
    expect(providerModels.claude ?? []).not.toContain("claude-sonnet-4-6");
    expect(providerModels.antigravity ?? []).not.toContain("claude-sonnet-4-6");
    expect(warnings.some((w) => w.includes("claude-sonnet-4-6"))).toBe(true);
  });

  it("live evidence supersedes the owned_by fallback for providers whose file answered", () => {
    // Claude's live set excludes the id (its quota keys are withheld by the
    // caller once live answers); antigravity's live set includes it. The
    // catalog still says owned_by: anthropic — a stale fallback that must not
    // fabricate an overlap once live has spoken for both providers.
    const served = parseModelsPayload({
      data: [{ id: "shared-live-model", owned_by: "anthropic" }],
    }).models;
    const { providerModels, overlaps } = deriveProviderModels(served, {
      authProviders: ["claude", "antigravity"],
      observedKeysByProvider: new Map(),
      servedByProvider: new Map([["antigravity", new Set(["shared-live-model"])]]),
      liveOkProviders: ["claude", "antigravity"],
    });
    expect(providerModels.antigravity).toEqual(["shared-live-model"]);
    expect(providerModels.claude ?? []).not.toContain("shared-live-model");
    expect(overlaps).toEqual([]);
  });

  it("a successful empty served set means the provider serves nothing in the catalog", () => {
    // Claude's file answered with an empty set: live says it serves nothing,
    // so owned_by: anthropic cannot claim the id for it — unattributed with
    // a warning, never a false single attribution.
    const served = parseModelsPayload({
      data: [{ id: "stale-owned-model", owned_by: "anthropic" }],
    }).models;
    const { providerModels, overlaps, warnings } = deriveProviderModels(served, {
      authProviders: ["claude"],
      observedKeysByProvider: new Map(),
      servedByProvider: new Map([["claude", new Set()]]),
      liveOkProviders: ["claude"],
    });
    expect(providerModels).toEqual({});
    expect(overlaps).toEqual([]);
    expect(warnings.some((w) => w.includes("stale-owned-model"))).toBe(true);
  });

  it("a served set alone claims a bare id the heuristic never saw", () => {
    // google-owned Antigravity Gemini ids: no model_quotas, unhelpful
    // owned_by — the served set attributes them once the endpoint lands.
    const served = parseModelsPayload({ data: [{ id: "gemini-3-pro" }] }).models;
    const { providerModels, overlaps } = deriveProviderModels(served, {
      authProviders: ["antigravity"],
      observedKeysByProvider: new Map(),
      servedByProvider: new Map([["antigravity", new Set(["gemini-3-pro"])]]),
    });
    expect(providerModels.antigravity).toEqual(["gemini-3-pro"]);
    expect(overlaps).toEqual([]);
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
