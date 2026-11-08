import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { CONNECTOR_CONFIG_SCHEMA, parseConfig } from "./config.js";

const base = {
  cliproxyBaseUrl: "http://127.0.0.1:8317", managementKeyHeader: "X-Test-Key",
  managementSecretRef: { uid: "secret-1" },
};

describe("alias schema/parser parity", () => {
  const validate = new Ajv({ strict: false }).compile(CONNECTOR_CONFIG_SCHEMA);
  it.each([
    { binding: { connectionId: "primary", connectionIds: [] }, valid: true },
    { binding: { connectionIds: [] }, valid: false },
    { binding: { connectionIds: ["alias"] }, valid: true },
    { binding: {}, valid: false },
    { binding: { connectionId: "primary", connectionIds: [""] }, valid: false },
  ])("validates $binding as $valid", ({ binding, valid }) => {
    const raw = { ...base, providers: [{ provider: "codex", ...binding }] };
    expect(validate(raw)).toBe(valid);
    expect(parseConfig(raw).validation.ok).toBe(valid);
  });
});

describe("routing configuration safety", () => {
  it.each([
    { ignoredAuthFileRefs: ["not-a-ref"] }, { ignoredProviders: 42 },
  ])("does not make display-only drift errors routing failures: %j", (extra) => {
    expect(parseConfig({ ...base, ...extra }).validation).toMatchObject({ ok: false, routingOk: true });
  });
  it.each([
    { providerWindows: { codex: 42 } }, { reservePercent: 50 },
    { cliproxyBaseUrl: "https://not-loopback.example" },
    { providers: [{ provider: "codex", connectionIds: [] }] },
    { providers: [{ provider: "codex", connectionId: "shared" }, { provider: "claude", connectionId: "shared" }] },
  ])("keeps operational and binding errors fail-closed: %j", (extra) => {
    expect(parseConfig({ ...base, ignoredAuthFileRefs: ["bad"], ...extra }).validation)
      .toMatchObject({ ok: false, routingOk: false });
  });
});
