import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_ID, PLUGIN_VERSION } from "./manifest.js";

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
