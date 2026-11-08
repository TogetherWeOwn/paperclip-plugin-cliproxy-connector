import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from './node_modules/playwright-core/index.mjs';
import { permittedRequest } from './policy.mjs';
import { assertBrowserComplete } from './receipt.mjs';

const base = 'http://127.0.0.1:3100';
const evidence = '/qualification/evidence';
const identity = JSON.parse(readFileSync(`${evidence}/identity.json`, 'utf8'));
const uiDigest = identity.artifacts['dist/ui/index.js'];
const browser = await chromium.launch({ headless: true });
const sessions = new Map();
const receipt = { qualificationStatus: 'partial-browser-only', attempts: [], observations: [], failures: [] };
const save = () => writeFileSync(`${evidence}/browser.json`, JSON.stringify(receipt, null, 2));

async function sessionFor(key, path, phase) {
  if (phase !== 'single' && phase !== 'before') {
    assert(sessions.has(key), 'Transition must reuse its pre-boundary browser session');
    return sessions.get(key);
  }
  assert(!sessions.has(key), 'Duplicate browser observation key');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const session = { context, page: await context.newPage(), path, errors: [], requests: [], loadedUi: [], pending: [] };
  sessions.set(key, session);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const allowed = permittedRequest(request.url(), request.method(), path);
    session.requests.push({ method: request.method(), origin: url.origin, path: url.pathname, allowed });
    if (!allowed) {
      session.errors.push({ kind: 'request-denied', origin: url.origin, path: url.pathname });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.origin === 'ws://127.0.0.1:3100' && /^\/api\//.test(url.pathname)) socket.connectToServer();
    else {
      session.errors.push({ kind: 'websocket-denied', origin: url.origin, path: url.pathname });
      socket.close();
    }
  });
  session.page.on('console', message => {
    if (message.type() === 'error') session.errors.push({ kind: 'console', message: message.text() });
  });
  session.page.on('pageerror', error => session.errors.push({ kind: 'pageerror', message: error.message }));
  session.page.on('requestfailed', request => session.errors.push({ kind: 'requestfailed', url: request.url(), error: request.failure()?.errorText }));
  session.page.on('response', response => {
    if (response.status() >= 400) session.errors.push({ kind: 'http', url: response.url(), status: response.status() });
    if (/\/_plugins\/[^/]+\/ui\/.*index\.js$/.test(new URL(response.url()).pathname)) {
      session.pending.push(response.body().then(bytes => {
        session.loadedUi.push({ url: response.url(), sha256: createHash('sha256').update(bytes).digest('hex') });
      }));
    }
  });
  await session.page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return session;
}

async function closeSession(key) {
  const session = sessions.get(key);
  if (!session) return;
  await session.context.tracing.stop({ path: `${evidence}/browser-${key}-trace.zip` });
  await session.context.close();
  sessions.delete(key);
}

async function observe(input) {
  const { key, path, phase, expected, boundary } = input;
  assert(/^[a-z0-9-]+$/.test(key));
  assert(/^\/[A-Z0-9]+\/plugins\/[a-f0-9-]+$/.test(path));
  assert(['single', 'before', 'after', 'recovered'].includes(phase));
  const session = await sessionFor(key, path, phase);
  const deadline = Date.now() + 70_000;
  let observation;
  let last;
  let lastText = null;
  do {
    for (const frame of session.page.frames()) {
      try {
        const line = frame.getByText(/connection synthetic-codex-connection · completeInventory/);
        if (await line.count() !== 1) continue;
        const card = line.locator('..');
        await card.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        const text = await card.innerText({ timeout: 1000 });
        lastText = text;
        assert.equal(await card.getByText(expected.state, { exact: true }).count(), 1, `Browser verdict is not ${expected.state}`);
        assert.equal(await card.getByText(expected.freshness, { exact: true }).count(), 1);
        assert.equal(text.includes('paid credits count as headroom'), expected.creditsCountAsHeadroom);
        assert.equal(text.includes('1 with headroom'), expected.headroomAccounts === 1);
        if (expected.creditHeadroomAccounts === 1) assert(text.includes('1 account routing on credits'));
        const credits = expected.accounts[0].credits;
        if (credits) {
          const creditState = credits.positive ? credits.unlimited ? 'unlimited' : 'available'
            : credits.hasCredits === false || (credits.balance !== null && credits.balance <= 0) ? 'none left' : 'unknown';
          assert(text.includes(`credits ${creditState}`));
          if (credits.balance !== null) assert(text.includes(`balance ${credits.balance}`));
          if (credits.observedAt) assert(text.includes(`seen ${credits.observedAt}`));
        }
        assert(text.includes(`checked ${expected.accounts[0].checkedAt}`));
        for (const model of expected.models) assert(text.includes(expected.modelNames[model] ?? model));
        if (key === 'hardened-display-refresh') assert(!text.includes('Qualification Model'), 'Old display cache survived browser load');
        assert(!text.includes('sk-qualification-display-must-not-survive'));
        assert(!text.includes('qualification-fixture-not-a-real-credential'));
        if (phase === 'before' && boundary && expected.retryAt) assert(text.includes('(0m)'), 'Active countdown was not rendered');
        await Promise.all(session.pending);
        assert(session.loadedUi.some(file => file.sha256 === uiDigest), 'Browser did not load exact candidate UI bytes');
        assert.deepEqual(session.errors, [], 'Browser network/console failure');
        observation = { key, phase, path, observedAt: new Date().toISOString(), expectedState: expected.state, text, loadedUi: session.loadedUi, requests: [...session.requests] };
        break;
      } catch (error) { last = error; }
    }
    if (observation) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  await session.page.screenshot({ path: `${evidence}/browser-${key}-${phase}.png`, fullPage: true });
  await Promise.all(session.pending);
  const result = { key, phase, observedAt: new Date().toISOString(),
    exactCandidateUiLoaded: session.loadedUi.some(file => file.sha256 === uiDigest), agreement: Boolean(observation) };
  receipt.attempts.push(result);
  if (observation) receipt.observations.push(observation);
  else {
    // Preserve candidate failures while collecting the remaining independent
    // controls. /finish still fails the job if any observation disagrees.
    receipt.failures.push({ key, phase, at: result.observedAt, expected, text: lastText,
      message: `Browser agreement deadline exceeded: ${last?.message ?? 'No installed provider card rendered'}`,
      errors: [...session.errors], loadedUi: [...session.loadedUi], requests: [...session.requests] });
  }
  save();
  if (phase === 'single' || phase === 'recovered') await closeSession(key);
  return result;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, version: browser.version() }));
      return;
    }
    if (req.method === 'POST' && req.url === '/finish') {
      assert.equal(sessions.size, 0);
      assertBrowserComplete(receipt);
      receipt.conclusion = 'success';
      receipt.browserVersion = browser.version();
      receipt.finishedAt = new Date().toISOString();
      save();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ conclusion: receipt.conclusion, observations: receipt.observations.length }));
      server.close();
      await browser.close();
      return;
    }
    assert(req.method === 'POST' && req.url === '/observe');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; assert(size < 100_000); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const result = await observe(input);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    receipt.failures.push({ at: new Date().toISOString(), message: error.message,
      sessions: [...sessions.entries()].map(([key, session]) => ({ key, errors: session.errors, requests: session.requests, loadedUi: session.loadedUi })) });
    for (const key of sessions.keys()) await closeSession(key);
    save();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
save();
server.listen(4310, '127.0.0.1', () => console.log('Bounded browser observer ready'));
