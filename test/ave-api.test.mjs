import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../src/server.mjs';
import { AveError } from '../src/ave-settings.mjs';

function fixture() {
  const calls = [];
  const snapshot = () => ({
    configured: true, requiresReentry: false, hasStoredKey: true,
    data: { configured: true, status: 'connected', message: 'ok', extra: 'hidden-ave-key' },
    trade: { configured: true, status: 'error', code: 'AVE_AUTH' },
    executionReady: true, executionReason: 'should-be-forced-false', apiKey: 'hidden-ave-key'
  });
  const ave = {
    snapshot,
    configure: async body => { calls.push(body); return snapshot(); },
    remove: body => { calls.push(['remove', body]); return { configured: false, data: {}, trade: {}, executionReady: false }; }
  };
  const server = createServer({
    state: { value: { activeChain: 'robinhood', candidates: [] } },
    settings: { port: 3791, publicDir: path.resolve('public') },
    ave,
    controls: { value: { enabledChains: ['robinhood'] } }
  });
  return { server, calls };
}

async function dispatch(server, { method = 'POST', url = '/api/ave-configure', body, origin = 'http://127.0.0.1:3791' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method, url, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3791', origin, 'content-type': 'application/json' }
  });
  return new Promise((resolve, reject) => {
    let code = 200;
    Promise.resolve(server.listeners('request')[0](req, {
      setHeader() {},
      writeHead(v) { code = v; },
      end(v) { resolve({ code, body: v ? JSON.parse(v) : null }); }
    })).catch(reject);
  });
}

test('AVE configure requires origin and never returns the key or execution-ready', async () => {
  const { server, calls } = fixture();
  assert.equal((await dispatch(server, { origin: '', body: { key: 'one-fixture-key' } })).code, 403);
  const saved = await dispatch(server, { body: { key: 'one-fixture-key' } });
  assert.equal(saved.code, 200);
  assert.equal(saved.body.ave.configured, true);
  assert.equal(saved.body.ave.executionReady, false);
  assert.doesNotMatch(JSON.stringify(saved.body), /hidden-ave-key|one-fixture-key/);
  assert.deepEqual(calls, [{ key: 'one-fixture-key' }]);
});

test('AVE status is included on public status without credentials', async () => {
  const { server } = fixture();
  const { body } = await dispatch(server, { method: 'GET', url: '/api/status' });
  assert.equal(body.ave.configured, true);
  assert.equal(body.ave.executionReady, false);
  assert.equal(body.ave.trade.code, 'AVE_AUTH');
  assert.ok(body.voiceSnapshot.chains.robinhood);
  assert.doesNotMatch(JSON.stringify(body), /hidden-ave-key/);
});

test('AVE configure errors stay coded and keep the previous snapshot', async () => {
  const { server } = fixture();
  const ave = { snapshot: () => ({ configured: true, data: { status: 'connected' }, trade: { status: 'connected' } }),
    configure: async () => { throw new AveError('AVE_CHECK_FAILED', 'hidden-ave-key', 502); } };
  const failing = createServer({
    state: { value: { activeChain: 'robinhood', candidates: [] } },
    settings: { port: 3791, publicDir: path.resolve('public') },
    ave
  });
  const response = await dispatch(failing, { body: { key: 'new-secret-fixture' } });
  assert.equal(response.code, 502);
  assert.equal(response.body.error, 'AVE_CHECK_FAILED');
  assert.equal(response.body.ave.configured, true);
  assert.doesNotMatch(JSON.stringify(response.body), /hidden-ave-key|new-secret-fixture/);
});
