import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { assertHostRelease, CANDIDATE_VERSION, digest, filesUnder, HOST_SOURCE } from './identity.mjs';
import { installedMatrix } from './installed.mjs';

const base = 'http://127.0.0.1:3100';
const evidence = '/qualification/evidence';
const candidate = '/qualification/candidate';
const report = {
  qualificationStatus: 'partial-preflight-only',
  startedAt: new Date().toISOString(),
  checks: [],
  missing: ['installed scenario matrix', 'native router eligibility', 'browser assertions and traces', 'specialist verdicts'],
};

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  assert(path.startsWith('/api/'));
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'error',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok) {
    // This namespace contains only synthetic data. Retain the bounded stock
    // error, never a request body, config response or secret reference value.
    const detail = typeof payload.error === 'string' ? payload.error.slice(0, 1200) : 'No stock error message';
    report.httpFailure = { path, status: response.status, detail };
    throw new Error(`${path}: HTTP ${response.status}: ${detail}`);
  }
  return payload;
}

async function ready() {
  const deadline = Date.now() + 180_000;
  let last;
  do {
    try {
      const health = await api('/api/health');
      if (health.status === 'ok') {
        const response = await fetch('http://127.0.0.1:4310/ready', { signal: AbortSignal.timeout(3000) });
        const browser = await response.json();
        assert(response.ok && browser.ready, 'Browser is not ready');
        report.browserVersion = browser.version;
        return health;
      }
      last = new Error('Host health is not ok');
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error(`Stock readiness deadline exceeded: ${last?.message}`);
}

try {
  assert.equal(process.env.PAPERCLIP_BUILD_COMMIT, HOST_SOURCE);
  assert.equal(process.env.PAPERCLIP_DEPLOYMENT_MODE, 'local_trusted');
  const health = await ready();
  report.hostHealth = {
    status: health.status,
    version: health.version,
    deploymentMode: health.deploymentMode,
    deploymentExposure: health.deploymentExposure,
  };
  report.actualHostBuildVersion = process.env.PAPERCLIP_BUILD_VERSION;
  report.actualHostSource = process.env.PAPERCLIP_BUILD_COMMIT;
  report.hostFiles = {};
  for (const file of ['/app/server/package.json', '/app/server/dist-runtime/index.mjs']) {
    report.hostFiles[file] = digest(file);
  }
  report.actualServerPackageVersion = JSON.parse(readFileSync('/app/server/package.json', 'utf8')).version;
  assertHostRelease(health.version);
  assert.equal(health.deploymentMode, 'local_trusted');
  assert.equal(health.deploymentExposure, 'private');
  report.checks.push('exact stock release reached health readiness');

  // This is the installed path the stock loader consumes, not an SDK mock or
  // an import of the candidate into this driver process.
  let plugin = await api('/api/plugins/install', { packageName: candidate, isLocalPath: true });
  if (plugin.plugin) plugin = plugin.plugin;
  assert.equal(plugin.pluginKey, 'togetherweown.cliproxy-connector');
  assert.equal(plugin.version, CANDIDATE_VERSION);
  assert.equal(plugin.status, 'ready');
  assert.equal(plugin.packagePath, candidate);
  report.installedPlugin = { id: plugin.id, pluginKey: plugin.pluginKey, version: plugin.version, status: plugin.status, packagePath: plugin.packagePath };
  report.checks.push('stock local-path install reached ready');

  const pluginPath = `/api/plugins/${plugin.id}`;
  await api(`${pluginPath}/disable`, {});
  const enabled = await api(`${pluginPath}/enable`, {});
  assert.equal(enabled.status, 'ready');
  const workerHealth = await api(`${pluginPath}/health`);
  assert.equal(workerHealth.healthy, true);
  assert.equal(workerHealth.status, 'ready');
  report.registryHealth = { status: workerHealth.status, healthy: workerHealth.healthy };
  const company = await api('/api/companies', { name: 'Connector qualification test drive' });
  assert.equal(typeof company.id, 'string');
  const usage = await api(`${pluginPath}/bridge/data`, {
    key: 'cliproxy-usage', companyId: company.id, params: { companyId: company.id },
  });
  assert(Array.isArray(usage.data.providers));
  assert.equal(usage.data.providers.length, 0);
  report.checks.push('stock disable/enable and installed worker data RPC succeeded');

  const identity = JSON.parse(readFileSync(`${evidence}/identity.json`, 'utf8'));
  report.loadedPathArtifacts = Object.fromEntries(filesUnder(`${candidate}/dist`).map(file => [file.slice(candidate.length + 1), digest(file)]));
  assert.deepEqual(report.loadedPathArtifacts, identity.artifacts);
  report.checks.push('installed-path worker and UI file hashes equal pinned candidate build');
  // No route to the outside exists in the network-none namespace. Exercise a
  // documentation-only address, never a production or provider destination.
  let denied = false;
  try {
    await fetch('http://192.0.2.1:9', { signal: AbortSignal.timeout(2000) });
  } catch { denied = true; }
  assert(denied, 'Unexpected non-loopback egress');
  report.checks.push('non-loopback egress negative control denied');
  await installedMatrix({ api, pluginPath, companyId: company.id, evidence, report });
  report.preflightConclusion = 'success';
} catch (error) {
  report.preflightConclusion = 'failure';
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${evidence}/preflight.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
