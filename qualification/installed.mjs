import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

// Only the disposable network-none namespace runs this fixture. It implements
// telemetry reads, never inference, credential downloads or provider forwarding.
export const SYNTHETIC_KEY = 'qualification-fixture-not-a-real-credential';
export const REJECTED_DISPLAY = 'sk-qualification-display-must-not-survive';
const MODEL = 'gpt-6.1-sol';

export async function startFixture() {
  const state = { entries: [], requests: [], unexpected: [], displayName: 'Qualification Model' };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    state.requests.push({ method: req.method, path });
    const authorized = path === '/v1/models'
      ? req.headers.authorization === `Bearer ${SYNTHETIC_KEY}`
      : req.headers['x-qualification-key'] === SYNTHETIC_KEY;
    let body;
    if (req.method === 'GET' && authorized) {
      if (path === '/v8/management/credentials' || path === '/v0/management/auth-files') body = state.entries;
      if (path === '/v1/models') body = { data: [{ id: MODEL, owned_by: 'openai' }] };
      if (path === '/v0/management/auth-files/models' && url.searchParams.has('name')) {
        body = { models: [{ id: MODEL, display_name: state.displayName }] };
      }
      if (path === '/v0/management/api-key-usage') body = { api_keys: [] };
    }
    if (body === undefined) {
      state.unexpected.push({ method: req.method, path, authorized });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Fixture request is not allow-listed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

export function scenarioEntries({ credit = 'positive', healthy = false, gate = null, extra = [] } = {}) {
  const now = Date.now();
  const iso = offset => new Date(now + offset).toISOString();
  const observed = iso(0);
  const exhausted = { 'x-codex-secondary-used-percent': healthy ? '10' : '100', 'x-codex-secondary-reset-at': String(Math.floor((now + 3_600_000) / 1000)) };
  const credits = credit === 'absent' ? {} : {
    'x-codex-credits-has-credits': credit === 'false-unlimited' ? 'false' : 'true',
    'x-codex-credits-unlimited': ['unlimited', 'false-unlimited'].includes(credit) ? 'true' : 'false',
    ...(['unlimited', 'no-balance'].includes(credit) ? {} : { 'x-codex-credits-balance': credit === 'zero' ? '0' : '12.5' }),
  };
  const quota = { observed_at: observed, signals: exhausted };
  const creditQuota = { signals: credits, ...(credit === 'undated' ? {} : { observed_at: credit === 'stale' ? iso(-3 * 3_600_000) : observed }) };
  const entry = {
    id: 'synthetic-codex-account', name: 'qualification-codex.json', provider: 'codex',
    quota, model_quotas: { [MODEL]: creditQuota },
  };
  if (gate === 'retry-after') quota.signals['retry-after'] = '120';
  if (gate === 'spend-control') quota.signals = [{ window: 'secondary', spend_control_blocked: true, reset_at: iso(3_600_000) }];
  if (gate === 'cooldown') entry.cooldowns = [{ scope: 'credential', reason: 'credential_quota', retry_at: iso(120_000) }];
  if (gate === 'expired-cooldown') entry.cooldowns = [{ scope: 'credential', reason: 'credential_quota', retry_at: iso(-60_000) }];
  if (gate === 'unavailable') { entry.unavailable = true; entry.next_retry_after = iso(120_000); }
  if (gate === 'rejected-reason') entry.cooldowns = [{ scope: 'credential', reason: REJECTED_DISPLAY, retry_at: iso(120_000) }];
  if (gate === 'reset-passed') quota.signals['x-codex-secondary-reset-at'] = String(Math.floor((now - 60_000) / 1000));
  return [entry, ...extra];
}

export const TRANSITIONS = [
  { name: 'credits-age-past-freshness-bound', before: 'allowed', headroom: 1 },
  { name: 'exhausted-window-reset-passes', before: 'exhausted', headroom: 0 },
  { name: 'unavailable-retry-passes-then-refresh-recovers', before: 'exhausted', headroom: 0 },
];

export function timedEntries(name, now = Date.now()) {
  // Leave enough time to prove the pre-boundary state via real installed RPCs.
  // The boundary is fixture telemetry, never a fake host/worker clock.
  const boundary = now + 15_000;
  const entries = scenarioEntries({ credit: name === 'exhausted-window-reset-passes' ? 'absent' : 'positive' });
  const entry = entries[0];
  if (name === 'credits-age-past-freshness-bound') {
    // Frozen config defaults: 5-minute sync × maxAgeMultiplier 2.
    entry.model_quotas[MODEL].observed_at = new Date(boundary - 600_000).toISOString();
  } else if (name === 'exhausted-window-reset-passes') {
    entry.quota.signals['x-codex-secondary-reset-at'] = String(Math.floor(boundary / 1000));
  } else if (name === 'unavailable-retry-passes-then-refresh-recovers') {
    entry.unavailable = true;
    entry.next_retry_after = new Date(boundary).toISOString();
  } else throw new Error(`Unknown installed transition: ${name}`);
  return { entries, boundary };
}

async function waitUntil(deadline, maximumMs) {
  const waitMs = Math.max(0, deadline - Date.now());
  assert(waitMs <= maximumMs, 'Unexpected telemetry or minimum-sync deadline');
  await new Promise(resolve => setTimeout(resolve, waitMs));
}

export const SCENARIOS = [
  { name: 'opt-in-omitted', optIn: undefined, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'opt-in-false', optIn: false, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'positive', optIn: true, state: 'allowed', headroom: 1, creditHeadroom: 1 },
  { name: 'unlimited', credit: 'unlimited', optIn: true, state: 'allowed', headroom: 1, creditHeadroom: 1 },
  { name: 'positive-no-balance', credit: 'no-balance', optIn: true, state: 'allowed', headroom: 1, creditHeadroom: 1 },
  { name: 'has-credits-false-defeats-unlimited', credit: 'false-unlimited', optIn: true, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'zero', credit: 'zero', optIn: true, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'absent', credit: 'absent', optIn: true, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'stale-selectable-unknown-not-headroom', credit: 'stale', optIn: true, state: 'unknown', headroom: 0, creditHeadroom: 0 },
  { name: 'undated-selectable-unknown-not-headroom', credit: 'undated', optIn: true, state: 'unknown', headroom: 0, creditHeadroom: 0 },
  { name: 'fresh-healthy-windows-stale-credits', healthy: true, credit: 'stale', optIn: true, state: 'allowed', headroom: 1, creditHeadroom: 0 },
  { name: 'cooldown-not-credit-coverable', gate: 'cooldown', optIn: true, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'retry-after-not-credit-coverable', gate: 'retry-after', optIn: true, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'spend-control-not-credit-coverable', gate: 'spend-control', optIn: true, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'unavailable-not-credit-coverable', gate: 'unavailable', optIn: true, state: 'exhausted', headroom: 0, creditHeadroom: 0 },
  { name: 'expired-cooldown-fresh-credits-recovery', gate: 'expired-cooldown', optIn: true, state: 'allowed', headroom: 1, creditHeadroom: 1 },
  { name: 'past-window-reset-no-credits-is-unknown', gate: 'reset-passed', credit: 'absent', optIn: true, state: 'unknown', headroom: 0, creditHeadroom: 0 },
  { name: 'hardened-display-refresh', gate: 'rejected-reason', optIn: true, state: 'allowed', headroom: 1, creditHeadroom: 1 },
];

export async function installedMatrix({ api, pluginPath, companyId, evidence, report }) {
  const fixture = await startFixture();
  const receipt = { qualificationStatus: 'partial-installed-matrix-only', scenarios: [], missing: ['native router eligibility', 'browser assertions and traces', 'specialist verdicts'] };
  try {
    let secretRef;
    const configure = async (optIn, name) => {
      // Independent companies avoid bypassing the worker's real 60s resync
      // throttle. The same-company refresh below observes that throttle.
      companyId = (await api('/api/companies', { name: `Fixture ${name}` })).id;
      secretRef = {};
      for (const key of ['managementSecretRef', 'clientApiKeySecretRef']) {
        const secret = await api(`/api/companies/${companyId}/secrets`, {
          name: `qualification-${key}`, value: SYNTHETIC_KEY,
        });
        secretRef[key] = { type: 'secret_ref', secretId: secret.id, version: 'latest' };
      }
      await api(`${pluginPath}/config`, { companyId, configJson: config(optIn) });
    };
    const config = optIn => ({
      cliproxyBaseUrl: fixture.baseUrl, managementKeyHeader: 'X-Qualification-Key',
      ...secretRef,
      audienceConfirmed: true, apiCallEnabled: { codex: false, claude: false, meta: false },
      providers: [{ provider: 'codex', connectionId: 'synthetic-codex-connection', completeInventory: true,
        ...(optIn === undefined ? {} : { creditsCountAsHeadroom: optIn }) }],
    });
    const usage = async () => (await api(`${pluginPath}/bridge/data`, {
      key: 'cliproxy-usage', companyId, params: { companyId },
    })).data;
    const refresh = async () => {
      const before = fixture.state.requests.length;
      const { data: sync } = await api(`${pluginPath}/bridge/action`, {
        key: 'cliproxy-resync', companyId, params: { companyId },
      });
      assert.equal(sync.skipped, false, JSON.stringify(sync));
      receipt.lastSyncFinishedAt = sync.finishedAt;
      assert(sync.rowsWritten >= 1, 'Installed sync persisted no account rows');
      assert(fixture.state.requests.slice(before).some(r => r.path === '/v8/management/credentials' || r.path === '/v0/management/auth-files'));
      return usage();
    };
    for (const scenario of SCENARIOS) {
      receipt.currentScenario = scenario.name;
      fixture.state.entries = scenarioEntries(scenario);
      fixture.state.displayName = 'Qualification Model';
      await configure(scenario.optIn, scenario.name);
      if (scenario.name === 'hardened-display-refresh') {
        const before = await refresh();
        assert(Object.values(before.providers[0].modelNames).includes('Qualification Model'), 'Safe display name was not cached');
        fixture.state.displayName = REJECTED_DISPLAY;
        // Wait only for the actual minimum-sync deadline, with a finite bound;
        // do not change the worker clock, cache, SDK or persisted host state.
        const waitMs = Math.max(0, Date.parse(receipt.lastSyncFinishedAt) + 60_100 - Date.now());
        assert(waitMs <= 60_100);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      const data = await refresh();
      const codex = data.providers.find(p => p.provider === 'codex');
      assert(codex, 'No installed provider card');
      assert.equal(codex.state, scenario.state, scenario.name);
      assert.equal(codex.headroomAccounts, scenario.headroom, scenario.name);
      assert.equal(codex.creditHeadroomAccounts, scenario.creditHeadroom, scenario.name);
      assert.equal(codex.enabledAccounts, 1, scenario.name);
      assert.equal(codex.creditsCountAsHeadroom, scenario.optIn === true, scenario.name);
      if (scenario.credit === 'absent') assert.equal(codex.accounts[0].credits, null);
      else if (scenario.credit === 'undated') assert.equal(codex.accounts[0].credits.observedAt, null);
      else assert.equal(typeof codex.accounts[0].credits.observedAt, 'string');
      assert(!JSON.stringify(data).includes(SYNTHETIC_KEY), 'Synthetic auth value leaked to worker UI data');
      assert(!JSON.stringify(data).includes(REJECTED_DISPLAY), 'Rejected display metadata survived deterministic refresh');
      if (scenario.name === 'hardened-display-refresh') {
        assert(!Object.values(codex.modelNames).includes('Qualification Model'), 'Old model display cache survived refresh');
      }
      receipt.scenarios.push({ name: scenario.name, expected: { state: scenario.state, headroom: scenario.headroom, creditHeadroom: scenario.creditHeadroom }, actual: codex });
    }
    // Worker restart must read the persisted data, without any telemetry request.
    const persisted = await usage();
    const readsBeforeRestart = fixture.state.requests.length;
    await api(`${pluginPath}/disable`, {});
    await api(`${pluginPath}/enable`, {});
    const reloaded = await usage();
    const stableProviders = data => JSON.parse(JSON.stringify(data.providers, (key, value) => key.endsWith('In') ? undefined : value));
    assert.deepEqual(stableProviders(reloaded), stableProviders(persisted));
    assert.equal(fixture.state.requests.length, readsBeforeRestart);
    receipt.persistence = 'worker disable/enable retained provider/account data without fixture reads';

    // One account cannot donate credits to another, nor to another provider.
    fixture.state.entries = scenarioEntries({ credit: 'zero' });
    const [other] = scenarioEntries();
    fixture.state.entries.push({ ...other, id: 'synthetic-disabled', name: 'qualification-disabled.json', disabled: true });
    fixture.state.entries.push({ ...other, id: 'synthetic-claude', name: 'qualification-claude.json', provider: 'claude' });
    await configure(true, 'account-provider-isolation');
    const isolated = await refresh();
    const isolatedCodex = isolated.providers.find(p => p.provider === 'codex');
    assert.equal(isolatedCodex.state, 'exhausted');
    assert.equal(isolatedCodex.enabledAccounts, 1);
    assert.equal(isolatedCodex.creditHeadroomAccounts, 0);
    const otherCompany = await api('/api/companies', { name: 'Unconfigured isolation control' });
    const otherUsage = (await api(`${pluginPath}/bridge/data`, {
      key: 'cliproxy-usage', companyId: otherCompany.id, params: { companyId: otherCompany.id },
    })).data;
    assert.equal(otherUsage.providers.length, 0);
    receipt.isolation = { disabledAccountAndOtherProviderCannotDonateCredits: true, unconfiguredCompanyHasNoProviders: true };

    // The frozen candidate maps one raw provider to one connection. Test the
    // preservation constraint through the installed worker, without saving a
    // duplicate, replacing a binding, or inventing a provider alias.
    const retainedConfig = config(true);
    retainedConfig.providers.push({ provider: 'claude', connectionId: 'synthetic-retained-other-connection', completeInventory: false });
    const validate = configJson => api(`${pluginPath}/config/test`, { companyId, configJson });
    const retained = await validate(retainedConfig);
    assert.equal(retained.valid, true, JSON.stringify(retained));
    const additiveConfig = { ...retainedConfig, providers: [...retainedConfig.providers,
      { provider: 'codex', connectionId: 'synthetic-sol-connection', completeInventory: true, creditsCountAsHeadroom: true }] };
    const additive = await validate(additiveConfig);
    assert.equal(additive.valid, false, 'Frozen candidate unexpectedly accepts two codex connection rows');
    assert.match(additive.message, /duplicate provider row.*codex.*keep one row per provider/);
    const replacementConfig = { ...retainedConfig, providers: retainedConfig.providers.map(row =>
      row.provider === 'codex' ? { ...row, connectionId: 'synthetic-sol-connection' } : row) };
    const replacement = await validate(replacementConfig);
    assert.equal(replacement.valid, true, JSON.stringify(replacement));
    assert.deepEqual(stableProviders(await usage()), stableProviders(isolated), 'Non-mutating config tests changed installed usage');
    receipt.mappingContract = {
      conclusion: 'unsupported-preserving-distinct-codex-bindings',
      installedWorkerValidation: { retained, additive, replacement },
      retainedProviderRows: retainedConfig.providers,
      attemptedAdditiveProviderRows: additiveConfig.providers,
      configTestIsNonMutating: true,
      limitation: 'One raw provider row has one connectionId. Adding codex twice is rejected; a singleton replacement validates but fails the retained-binding requirement. No replacement was saved.',
      missing: 'Native Sol member assessment with both distinct codex bindings retained; no router execution is inferred from config validation.',
    };
    receipt.transitions = [];
    for (const transition of TRANSITIONS) {
      receipt.currentScenario = transition.name;
      await configure(true, transition.name);
      const { entries, boundary } = timedEntries(transition.name);
      fixture.state.entries = entries;
      const before = (await refresh()).providers.find(p => p.provider === 'codex');
      const beforeObservedAt = new Date().toISOString();
      assert(Date.now() < boundary - 1000, 'Pre-boundary installed observation arrived too late');
      assert.equal(before.state, transition.before, transition.name);
      assert.equal(before.headroomAccounts, transition.headroom, transition.name);
      const syncFinishedAt = receipt.lastSyncFinishedAt;
      const requestsBeforeExpiry = fixture.state.requests.length;
      // Read the same persisted rows after the advertised deadline, without
      // resync, cache writes, time injection or a newly expired fixture.
      await waitUntil(boundary + 100, 15_100);
      const after = (await usage()).providers.find(p => p.provider === 'codex');
      assert.equal(after.state, 'unknown', transition.name);
      assert.equal(after.headroomAccounts, 0, transition.name);
      assert.equal(after.creditHeadroomAccounts, 0, transition.name);
      assert.equal(fixture.state.requests.length, requestsBeforeExpiry, 'Expiry read unexpectedly refreshed telemetry');
      const result = {
        name: transition.name, boundary: new Date(boundary).toISOString(),
        beforeObservedAt, before, afterObservedAt: new Date().toISOString(), after,
        noTelemetryReadsAcrossExpiry: true,
      };
      receipt.transitions.push(result);
      // Recovery needs genuinely fresh telemetry, not the passing of a clock.
      // Respect the real same-company minimum-sync interval before requesting it.
      await waitUntil(Date.parse(syncFinishedAt) + 60_100, 60_100);
      fixture.state.entries = scenarioEntries();
      const recovered = (await refresh()).providers.find(p => p.provider === 'codex');
      assert.equal(recovered.state, 'allowed', transition.name);
      assert.equal(recovered.headroomAccounts, 1, transition.name);
      assert.equal(recovered.creditHeadroomAccounts, 1, transition.name);
      result.recoveredObservedAt = new Date().toISOString();
      result.recovered = recovered;
    }
    report.checks.push('installed wall-clock credit freshness, window reset and unavailable retry transitions recovered only after fresh telemetry');
    receipt.currentScenario = null;
    assert.deepEqual(fixture.state.unexpected, [], 'Unexpected fixture request or synthetic credential resolution failure');
    receipt.conclusion = 'success';
    report.checks.push('installed synthetic credit/gate matrix, deterministic metadata refresh and persisted-worker restart succeeded');
  } catch (error) {
    receipt.conclusion = 'failure';
    receipt.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    receipt.fixtureRequests = fixture.state.requests;
    receipt.unexpectedFixtureRequests = fixture.state.unexpected;
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(`${evidence}/installed-matrix.json`, JSON.stringify(receipt, null, 2));
    await fixture.close();
  }
}
