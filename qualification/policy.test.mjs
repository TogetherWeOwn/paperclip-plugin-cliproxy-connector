import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANDIDATE, HOST_SOURCE, HOST_IMAGE, assertHostRelease, digest, filesUnder } from './identity.mjs';
import { SCENARIOS, TRANSITIONS, scenarioEntries, timedEntries, startFixture, SYNTHETIC_KEY } from './installed.mjs';
import { permittedRequest } from './browser/policy.mjs';

const workflow = readFileSync(new URL('../.github/workflows/qualify-stock.yml', import.meta.url), 'utf8');
const driver = readFileSync(new URL('./preflight.mjs', import.meta.url), 'utf8');

test('workflow keeps candidate, workflow and stock identities separate', () => {
  assert(workflow.includes(`ref: ${CANDIDATE}`));
  assert(workflow.includes(`HOST_SOURCE_SHA: ${HOST_SOURCE}`));
  assert(workflow.includes(`STOCK_IMAGE: ghcr.io/paperclipai/paperclip@${HOST_IMAGE}`));
  assert(workflow.includes('path: workflow'));
  assert(workflow.includes('path: candidate'));
  assert(workflow.includes('persist-credentials: false'));
  assert(!workflow.includes('secrets.'));
});

test('matching source alone cannot qualify an older host release', () => {
  assertHostRelease('2026.1106.0');
  assertHostRelease('2026.1106.0+0.git.d69631b01b');
  assert.throws(() => assertHostRelease('2026.1005.0+845.git.d69631b01'));
  assert.throws(() => assertHostRelease('2026.1106.1'));
  assert.throws(() => assertHostRelease('2026.1106.0-rc.1'));
  assert.throws(() => assertHostRelease(undefined));
  assert(driver.includes('assertHostRelease(health.version)'));
});

test('runtime cannot reach provider or production services or retain a cloud resource', () => {
  assert(workflow.includes('runs-on: ubuntu-24.04'));
  assert(workflow.includes('timeout-minutes: 25'));
  assert(workflow.includes('--network none'));
  assert(workflow.includes('--pids-limit 2048 --memory 5g --cpus 2'));
  assert(!workflow.includes('docker.sock'));
  assert(!workflow.includes('--env-file'));
  assert(!workflow.includes('--network host'));
  assert(!workflow.includes('schedule:'));
  assert(workflow.includes('docker rm --force --volumes'));
  assert(workflow.includes('GitHub-hosted job VM disposal'));
  assert(workflow.includes('retention-days: 7'));
});

test('browser shares only the isolated namespace and has a separately pinned hook-free driver', () => {
  assert(workflow.includes('BROWSER_IMAGE: mcr.microsoft.com/playwright@sha256:42f02d323c310069b4d54c94bd91a608966a486c3492c48ae0b1cea747ec5ca2'));
  assert(workflow.includes('--network "container:$QUALIFICATION_CONTAINER"'));
  assert(workflow.includes('--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges'));
  assert(workflow.includes('for container in "$BROWSER_CONTAINER" "$QUALIFICATION_CONTAINER"'));
  const lock = JSON.parse(readFileSync(new URL('./browser/package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/playwright-core'].version, '1.56.1');
  assert.equal(Object.keys(lock.packages).length, 2);
  assert(!Object.values(lock.packages).some(pkg => pkg.hasInstallScript));
  const policy = readFileSync(new URL('./browser/.npmrc', import.meta.url), 'utf8');
  assert(policy.includes('min-release-age=3'));
  assert(policy.includes('ignore-scripts=true'));
});

test('browser request policy refuses external origins, fixture ports and mutation', () => {
  const path = '/FIX/plugins/00000000-0000-0000-0000-000000000000';
  const origin = 'http://127.0.0.1:3100';
  for (const allowed of [path, '/assets/index.js', '/_plugins/test/ui/index.js', '/api/companies']) {
    assert(permittedRequest(`${origin}${allowed}`, 'GET', path));
  }
  assert(permittedRequest(`${origin}/api/plugins/test/bridge/data`, 'POST', path));
  for (const url of ['https://example.invalid/v1', 'http://127.0.0.1:4310/observe', `${origin}/v1/models`]) {
    assert(!permittedRequest(url, 'GET', path));
  }
  for (const url of ['/api/plugins/test/config', '/api/plugins/test/bridge/action', '/api/companies']) {
    assert(!permittedRequest(`${origin}${url}`, 'POST', path));
  }
});

test('preflight never represents incomplete qualification as a pass', () => {
  assert(driver.includes("qualificationStatus: 'partial-preflight-only'"));
  assert(driver.includes("'native router eligibility'"));
  assert(driver.includes("'browser assertions and traces'"));
  assert(driver.includes('process.exitCode = 1'));
  assert(driver.includes('Stock readiness deadline exceeded'));
  assert(!driver.includes('globalThis.fetch ='));
  assert(!driver.includes('/v0/management'));
  assert(!driver.includes('/v8/management'));
});

test('installed matrix retains all opt-in, credit freshness and non-coverable gate controls', () => {
  assert.deepEqual(SCENARIOS.slice(0, 3).map(s => s.optIn), [undefined, false, true]);
  for (const credit of ['unlimited', 'no-balance', 'false-unlimited', 'zero', 'absent', 'stale', 'undated']) {
    assert(SCENARIOS.some(s => s.credit === credit), `Missing ${credit}`);
  }
  for (const gate of ['cooldown', 'retry-after', 'spend-control', 'unavailable', 'expired-cooldown', 'reset-passed', 'rejected-reason']) {
    assert(SCENARIOS.some(s => s.gate === gate), `Missing ${gate}`);
  }
  const [undated] = scenarioEntries({ credit: 'undated' });
  assert(!('observed_at' in undated.model_quotas['gpt-6.1-sol']));
  const [dated] = scenarioEntries();
  assert(Number.isFinite(Number(dated.quota.signals['x-codex-secondary-reset-at'])));
  const [unavailable] = scenarioEntries({ gate: 'unavailable' });
  assert.equal(unavailable.unavailable, true, 'Unavailable lifecycle uses the canonical boolean, not display status');
  assert(Date.parse(unavailable.next_retry_after) > Date.now());
});

test('timed fixtures start before real expiry and do not weaken frozen freshness defaults', () => {
  const now = Date.now();
  assert.equal(TRANSITIONS.length, 3);
  const credit = timedEntries(TRANSITIONS[0].name, now);
  assert.equal(credit.boundary, now + 15_000);
  assert.equal(Date.parse(credit.entries[0].model_quotas['gpt-6.1-sol'].observed_at) + 600_000, credit.boundary);
  const reset = timedEntries(TRANSITIONS[1].name, now);
  assert.equal(Number(reset.entries[0].quota.signals['x-codex-secondary-reset-at']), Math.floor(reset.boundary / 1000));
  assert.deepEqual(reset.entries[0].model_quotas['gpt-6.1-sol'].signals, {});
  const retry = timedEntries(TRANSITIONS[2].name, now);
  assert.equal(retry.entries[0].unavailable, true);
  assert.equal(Date.parse(retry.entries[0].next_retry_after), retry.boundary);
  assert.throws(() => timedEntries('unrecognized'), /Unknown installed transition/);
});

test('fixture accepts only authenticated telemetry reads and refuses inference or forwarding', async () => {
  const fixture = await startFixture();
  try {
    fixture.state.entries = scenarioEntries();
    const allowed = await fetch(`${fixture.baseUrl}/v8/management/credentials`, { headers: { 'X-Qualification-Key': SYNTHETIC_KEY } });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).length, 1);
    for (const [path, options] of [
      ['/v8/management/credentials', {}],
      ['/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${SYNTHETIC_KEY}` } }],
      ['/v0/management/api-call', { method: 'POST', headers: { 'X-Qualification-Key': SYNTHETIC_KEY } }],
      ['/v0/management/auth-files/download', { headers: { 'X-Qualification-Key': SYNTHETIC_KEY } }],
    ]) {
      const denied = await fetch(`${fixture.baseUrl}${path}`, options);
      assert.equal(denied.status, 400);
      await denied.text();
    }
    assert.equal(fixture.state.unexpected.length, 4);
  } finally { await fixture.close(); }
});

test('artifact hashes change with bytes and artifact enumeration rejects symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-policy-'));
  try {
    const file = join(dir, 'worker.js');
    writeFileSync(file, 'one');
    const first = digest(file);
    writeFileSync(file, 'two');
    assert.notEqual(digest(file), first);
    assert.deepEqual(filesUnder(dir), [file]);
    symlinkSync(file, join(dir, 'link.js'));
    assert.throws(() => filesUnder(dir), /Unexpected artifact symlink/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
