#!/usr/bin/env node
/**
 * Operator-run provisioning script: per-account Paperclip connections (+ pool
 * member specs) from the prefix map.
 *
 * OPERATOR ONLY. Agents must never run this: pool save is board-user REST and
 * this script needs a board credential. Usage:
 *
 *   PAPERCLIP_API_URL=https://paperclip.example.com \
 *   PAPERCLIP_BOARD_TOKEN_FILE=$HOME/.paperclip/board-token \
 *   node scripts/provision-connections.mjs --company <companyId> --map prefix-map.json [--apply] [--include-pools]
 *
 * Without --apply this is a dry run: it prints every connection payload and
 * pool member spec and changes nothing.
 *
 * !!! ENDPOINT ASSUMPTIONS (verify once against your instance, fix ENDPOINTS
 * below if they differ — everything else follows): !!!
 * - GET/POST  /api/companies/:companyId/ai-connections
 * - GET/PUT   /api/companies/:companyId/ai-connection-pools/:poolId
 *
 * prefix-map.json:
 * [
 *   {"prefix":"acct-claude-1","provider":"anthropic","protocol":"messages",
 *    "model":"claude-sonnet-5","connectionName":"CLIProxy · Claude acct 1",
 *    "effort":"high","pool":"messages"},
 *   ...
 * ]
 * `model` is the bare listed id; the script prefixes it: <prefix>/<model>.
 * Bearer auth on every connection is a CLIProxy *client* key — pass it via
 * CLIPROXY_CLIENT_KEY_FILE (file, never argv) or reuse one stored grant.
 */

import { readFileSync, existsSync } from "node:fs";

const ENDPOINTS = {
  connections: (api, companyId) => `${api}/api/companies/${companyId}/ai-connections`,
  pools: (api, companyId, poolId) => `${api}/api/companies/${companyId}/ai-connection-pools/${poolId}`,
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const has = (name) => args.includes(name);

const companyId = flag("--company");
const mapFile = flag("--map");
const apply = has("--apply");
const includePools = has("--include-pools");
if (!companyId || !mapFile) {
  console.error("usage: provision-connections.mjs --company <companyId> --map prefix-map.json [--apply] [--include-pools]");
  process.exit(2);
}

const api = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "");
const tokenFile = process.env.PAPERCLIP_BOARD_TOKEN_FILE ?? "";
if (!api || !tokenFile || !existsSync(tokenFile)) {
  console.error("set PAPERCLIP_API_URL and PAPERCLIP_BOARD_TOKEN_FILE (a file holding a board token).");
  process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();

const entries = JSON.parse(readFileSync(mapFile, "utf8"));
if (!Array.isArray(entries) || entries.length === 0) {
  console.error("map file must be a non-empty array.");
  process.exit(2);
}

async function apiCall(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text: text.slice(0, 500) };
}

function connectionPayload(e) {
  if (!e.prefix || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(e.prefix)) throw new Error(`bad prefix: ${e.prefix}`);
  const provider = e.provider === "openai" ? "openai" : "anthropic"; // forced by protocol for local/gateway
  return {
    name: e.connectionName ?? `CLIProxy · ${e.prefix}`,
    method: "api_key",
    provider,
    routing: {
      kind: "local",
      protocol: e.protocol ?? "messages",
      baseUrl: e.baseUrl ?? "http://127.0.0.1:8317",
      auth: "bearer",
      models: [`${e.prefix}/${e.model}`],
    },
  };
}

const existing = await apiCall("GET", ENDPOINTS.connections(api, companyId));
const existingRows = Array.isArray(existing.json) ? existing.json : (existing.json?.items ?? []);
console.log(`# existing connections visible: ${existingRows.length} (HTTP ${existing.status})`);

for (const e of entries) {
  const payload = connectionPayload(e);
  const match = existingRows.find((r) => (r.name ?? "") === payload.name);
  const profile =
    (payload.routing.protocol === "responses")
      ? { provider: "codex", model: `${e.prefix}/${e.model}`, effort: e.effort ?? "medium" }
      : { provider: "acpx", acpxAgent: "claude", model: `${e.prefix}/${e.model}`, effort: e.effort ?? "high" };
  console.log(`\n## ${e.prefix} → ${payload.name}`);
  console.log(`connection payload:\n${JSON.stringify(payload, null, 2)}`);
  console.log(`pool member profile (${e.pool ?? payload.routing.protocol} pool):\n${JSON.stringify({ binding: "(grant of the created connection)", profile }, null, 2)}`);
  if (!apply) continue;
  if (match) {
    console.log(`--apply: keeping existing connection ${match.id} (update in UI if routing changed).`);
  } else {
    const created = await apiCall("POST", ENDPOINTS.connections(api, companyId), payload);
    console.log(`--apply: POST → HTTP ${created.status} ${created.text}`);
  }
}

if (includePools && apply) {
  console.log("\n# --include-pools: add one member per connection to the named pool via the board UI payload above.");
  console.log("# Pool save is board-user REST; verify ENDPOINTS.pools against your instance before automating it.");
}
if (!apply) console.log("\n# dry run: nothing changed. Re-run with --apply to create connections.");
