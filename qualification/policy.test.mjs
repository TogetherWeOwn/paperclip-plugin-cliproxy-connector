import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANDIDATE, HOST_SOURCE, HOST_IMAGE, digest, filesUnder } from './identity.mjs';

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
