import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest, { PLUGIN_ID, PLUGIN_VERSION } from "./manifest.js";
import { CONNECTOR_CONFIG_SCHEMA } from "./config.js";

describe("declarative connector settings", () => {
  it("publishes secret references, aliases and zero-reserve bounds", () => {
    expect(manifest.instanceConfigSchema).toEqual(CONNECTOR_CONFIG_SCHEMA);
    expect(CONNECTOR_CONFIG_SCHEMA.properties.managementSecretRef.type).toBe("object");
    expect(CONNECTOR_CONFIG_SCHEMA.properties.providers.items.anyOf).toEqual([
      { required: ["connectionId"] }, { required: ["connectionIds"] },
    ]);
    expect(CONNECTOR_CONFIG_SCHEMA.properties.reservePercent).toMatchObject({ minimum: 0, exclusiveMaximum: 50 });
    expect(CONNECTOR_CONFIG_SCHEMA.properties.perPoolReservePercent.additionalProperties.minimum).toBe(0);
    expect(CONNECTOR_CONFIG_SCHEMA.properties.syncIntervalMinutes.description).toContain("Freshness baseline");
    expect(manifest.jobs?.[0]?.schedule).toBe("*/5 * * * *");
  });
});

describe("plugin manifest version", () => {
  it("matches package.json so the host-reported version cannot drift", () => {
    const packageJson = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { name: string; version: string };
    expect(packageJson.name).toBe("@togetherweown/paperclip-plugin-cliproxy-connector");
    expect(PLUGIN_VERSION).toBe(packageJson.version);
    expect(PLUGIN_ID).toBe("togetherweown.cliproxy-connector");
  });
});
