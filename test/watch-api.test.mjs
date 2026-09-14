import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WatchPool } from '../src/watch-pool.mjs';
import { Readable } from 'node:stream';
import { createServer } from '../src/server.mjs';

const address = '0x1111111111111111111111111111111111111111';
function fixture() {
  const calls = [];
  const watchPool = {
    snapshot() { return ['robinhood', 'base'].map(chain => ({ chain, address, label: 'secret token', symbol: 'TEST', source: 'manual', reportedOutcome: 'USER_REPORTED_RUG', checkCount: 2, riskLatched: true, raw: 'hidden', latest: { status: 'WAIT_RECHECK', reasons: ['api_key=hidden'], error: 'Bearer hidden', price: null, raw: 'hidden' }, history: [{ status: 'ERROR', error: 'command failed hidden' }] })); },
    add(body) { calls.push(body); return { raw: 'hidden' }; },
    setPaused(body) { calls.push(body); }
  };
  const server = createServer({ state: { value: { activeChain: 'robinhood' } }, settings: { port: 3791, publicDir: path.resolve('public') }, watchPool, switchChain() { throw new Error('must not switch'); } });
  return { server, calls, watchPool };
}
async function dispatch(server, body, { origin = 'http://127.0.0.1:3791', url = '/api/watch-pool', method = 'POST', contentType = 'application/json' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3791', origin, 'content-type': contentType } });
  return new Promise((resolve, reject) => {
    const response = {};
    const res = { setHeader() {}, writeHead(code) { response.code = code; }, end(value) { response.body = JSON.parse(value); resolve(response); } };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}
test('watch writes require same origin and reject invalid fields before mutating', async () => {
  const { server, calls } = fixture();
  const valid = { action: 'add', chain: 'robinhood', address };
  for (const origin of ['', 'https://evil.example', 'http://localhost:3791']) assert.equal((await dispatch(server, valid, { origin })).code, 403);
  for (const body of [{ ...valid, raw: true }, { ...valid, chain: 'invalid' }, { ...valid, address: 'bad' }, { ...valid, reportedOutcome: 'SAFE' }, { ...valid, label: {} }, { ...valid, action: 'pause', paused: 'false' }]) assert.equal((await dispatch(server, body)).code, 400);
  assert.equal(calls.length, 0);
  assert.equal((await dispatch(server, valid, { contentType: 'text/plain' })).code, 415);
  assert.equal((await dispatch(server, { ...valid, label: 'x'.repeat(2048) })).code, 413);
});
test('watch add and pause only mutate local pool with allowlisted inputs', async () => {
  const { server, calls } = fixture();
  assert.equal((await dispatch(server, { action: 'add', chain: 'robinhood', address, reportedOutcome: 'USER_REPORTED_GRADUATED' })).code, 200);
  assert.equal((await dispatch(server, { action: 'pause', chain: 'robinhood', address, paused: true })).code, 200);
  assert.deepEqual(calls, [{ chain: 'robinhood', address, label: '', reportedOutcome: 'USER_REPORTED_GRADUATED' }, { chain: 'robinhood', address, paused: true }]);
});
test('watch status and export use independent sanitized all-chain snapshots', async () => {
  const { server } = fixture();
  for (const url of ['/api/status?chain=robinhood', '/api/export?chain=robinhood']) {
    const response = await dispatch(server, undefined, { method: 'GET', url });
    assert.equal(response.code, 200);
    assert.equal(response.body.watchPool.length, 2);
    assert.equal(response.body.watchPool[0].latest.price, null);
    assert.equal(response.body.watchPool[0].latest.liquidity, null);
    assert.doesNotMatch(JSON.stringify(response.body.watchPool), /hidden|api_key|Bearer|secret token/);
    assert.equal('raw' in response.body.watchPool[0], false);
  }
});
test('watch store errors preserve safe HTTP codes without leaking error messages', async () => {
  const { server, watchPool } = fixture();
  watchPool.add = () => { throw Object.assign(new Error('api_key=hidden'), { statusCode: 409 }); };
  const response = await dispatch(server, { action: 'add', chain: 'robinhood', address });
  assert.equal(response.code, 409);
  assert.doesNotMatch(JSON.stringify(response.body), /hidden/);
});

test('watch API and real persistent store agree on the 80-character label boundary', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new WatchPool(dir);
  const server = createServer({ state: { value: { activeChain: 'robinhood' } }, settings: { port: 3791, publicDir: path.resolve('public') }, watchPool: pool });
  const body = { action: 'add', chain: 'robinhood', address, label: 'x'.repeat(80) };
  assert.equal((await dispatch(server, body)).code, 200);
  assert.equal(new WatchPool(dir).snapshot()[0].label, body.label);
  assert.equal((await dispatch(server, { ...body, label: 'x'.repeat(81) })).code, 400);
  assert.equal(new WatchPool(dir).snapshot()[0].label, body.label);
  const mock = fixture();
  assert.equal((await dispatch(mock.server, { ...body, label: 'x'.repeat(81) })).code, 400);
  assert.equal(mock.calls.length, 0);
});
