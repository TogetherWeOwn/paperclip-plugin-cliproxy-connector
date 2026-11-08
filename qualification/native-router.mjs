import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const ROUTER_MODEL = 'gpt-6.1-sol';
export const REFUSAL_COMMAND = '/usr/bin/false';

// These APIs run only inside the disposable stock network-none host. A local
// Responses connection with auth:none creates no credential and probes no API.
export async function prepareNativeConnections({ api, companyId, baseUrl }) {
  const experimental = await api('/api/instance/settings/experimental');
  if (!experimental.enableAiConnectionRouters) {
    await api('/api/instance/settings/experimental', { enableAiConnectionRouters: true }, 'PATCH');
  }
  const bindings = {};
  for (const name of ['primary', 'alias', 'unrelated']) {
    const saved = await api(`/api/companies/${companyId}/ai-connections`, {
      name: `Synthetic ${name}`, provider: 'openai', method: 'api_key',
      ownership: 'shared', allAgents: true,
      routing: { kind: 'local', protocol: 'responses', baseUrl: `${baseUrl}/v1`, auth: 'none', models: [{ id: ROUTER_MODEL }] },
    });
    assert.equal(typeof saved.connectionId, 'string');
    assert.equal(typeof saved.grantId, 'string');
    bindings[name] = { mode: 'shared', provider: 'openai', method: 'api_key', ...saved };
  }
  return bindings;
}

export function assertNativeOutcome(run, { memberId, connectionId, model, state }) {
  assert(['failed', 'cancelled', 'succeeded', 'timed_out'].includes(run.status), 'Native run did not terminate');
  assert.equal(typeof run.contextSnapshot?.aiRouterTaskKey, 'string', 'Missing native task allocation key');
  const selection = run.contextSnapshot?.aiRouterSelection;
  if (state === 'exhausted') {
    assert.equal(run.errorCode, 'ai_connection_pool_exhausted', 'Native router did not exhaust the pool');
    assert.equal(run.resultJson?.executionRecovery?.providerWorkStarted, false);
    assert.equal(selection, undefined, 'Exhausted native run unexpectedly selected a member');
  } else {
    assert.equal(selection?.memberId, memberId, 'Native router did not select the authorized member');
    assert.equal(selection.binding.connectionId, connectionId);
    assert.equal(selection.runtimeConfig.model, model);
    // Selection is positive routing evidence, not successful inference. Any
    // successful model run is forbidden: the configured executable always fails.
    assert.notEqual(run.status, 'succeeded', 'Unexpected successful adapter execution');
    assert.notEqual(run.errorCode, 'ai_connection_pool_exhausted');
  }
  return selection ?? null;
}

export async function observeNativeAllocation({ api, companyId, bindings, fixture, name, state, model = ROUTER_MODEL, bindingName = 'alias' }) {
  const binding = bindings[bindingName];
  const memberId = randomUUID();
  const pool = await api(`/api/companies/${companyId}/ai-connection-pools`, {
    pluginKey: 'togetherweown.cliproxy-connector',
    config: { name: `Synthetic ${name}`, enabled: true, mode: 'round_robin', thresholdPercent: 100,
      members: [{ id: memberId, binding, profile: { provider: 'codex', model } }] },
  });
  // Bootstrap only this synthetic company through stock configuration. No
  // installed runtime, database row, production grant or real credential changes.
  await api(`/api/companies/${companyId}`, { requireBoardApprovalForNewAgents: false }, 'PATCH');
  const agent = await api(`/api/companies/${companyId}/agents`, {
    name: `Synthetic allocation ${name}`, role: 'ceo', runner: 'legacy', adapterType: 'codex_local',
    adapterConfig: { command: REFUSAL_COMMAND, model, cwd: '/tmp', timeoutSec: 10, graceSec: 1 },
    runtimeConfig: { aiConnection: { mode: 'router', connectionId: pool.id }, heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
  });
  assert.equal(agent.adapterType, 'codex_local');
  assert.equal(agent.adapterConfig.command, REFUSAL_COMMAND);
  let run;
  const readsBefore = fixture.state.requests.length;
  try {
    const invoked = await api(`/api/agents/${agent.id}/heartbeat/invoke`, {
      reason: 'synthetic-allocation-qualification', idempotencyKey: `qualification:${companyId}:${name}`,
    });
    assert.equal(typeof invoked.id, 'string', 'Native invocation was skipped');
    const deadline = Date.now() + 30_000;
    do {
      run = await api(`/api/heartbeat-runs/${invoked.id}`);
      if (['failed', 'cancelled', 'succeeded', 'timed_out'].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    const selection = assertNativeOutcome(run, { memberId, connectionId: binding.connectionId, model, state });
    assert.equal(fixture.state.requests.length, readsBefore, 'Native allocation contacted telemetry or inference');
    return {
      name, companyId, poolId: pool.id, memberId, connectionId: binding.connectionId, model,
      expectedState: state, nativeEligibility: state !== 'exhausted',
      runId: run.id, runStatus: run.status, errorCode: run.errorCode ?? null,
      taskKey: run.contextSnapshot?.aiRouterTaskKey, selection,
      exhaustedBeforeProviderWork: state === 'exhausted',
      configuredCommand: REFUSAL_COMMAND, noFixtureRequestsDuringAllocation: true,
      scope: 'stock on-demand run-key task allocation; no issue work or model inference',
    };
  } catch (error) {
    error.nativeObservation = {
      name, companyId, poolId: pool.id, memberId, connectionId: binding.connectionId, model,
      expectedState: state, runId: run?.id, runStatus: run?.status, errorCode: run?.errorCode,
      taskKey: run?.contextSnapshot?.aiRouterTaskKey, selection: run?.contextSnapshot?.aiRouterSelection,
      configuredCommand: REFUSAL_COMMAND, fixtureRequestsDuringAllocation: fixture.state.requests.slice(readsBefore),
    };
    throw error;
  } finally {
    // Pausing the synthetic agent cancels native exhausted-pool retries too.
    // VM disposal remains the hard cancellation bound if this call cannot run.
    await api(`/api/agents/${agent.id}/pause`, {});
  }
}
