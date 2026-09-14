import test from 'node:test';
import assert from 'node:assert/strict';
import { Scanner } from '../src/scanner.mjs';
import { config } from '../src/config.mjs';

const address = '0x' + '1'.repeat(40);
const freshAddress = '0x' + '2'.repeat(40);
function setup({ limit = 2, discovered = [], paused = false, riskLatched = false } = {}) {
  const calls = [], records = [], captures = [];
  const watchPool = {
    due: (chain, at, count) => paused ? [] : [{ chain, address, symbol: 'OLD', nextCheckAt: 0, riskLatched }].slice(0, count),
    snapshot: () => [{ chain: 'robinhood', address, riskLatched }],
    capture: (...args) => captures.push(args),
    record: (candidate) => records.push(structuredClone(candidate))
  };
  const state = { value: { activeChain: 'robinhood', candidates: [], outcomes: [], events: [], auditQueue: [] }, save(next) { if (next) this.value = next; } };
  const gmgn = {
    keyEpoch: 0, metrics: {}, configured: async () => true, discover: async () => discovered,
    audit: async (addr, now, chain, options) => {
      calls.push({ addr, chain, options });
      return { info: { symbol: 'FRESH', price: { price: 2 }, circulating_supply: 100000, liquidity: 4000 }, security: {}, pool: {}, holders: [], traders: [], candles: [], _meta: { complete: true } };
    }
  };
  const scanner = new Scanner({ gmgn, state, watchPool, settings: { ...config, maxDeepAuditsPerCycle: limit } });
  return { scanner, gmgn, state, calls, records, captures };
}

test('watch pool rechecks delisted addresses and records fresh evidence without promoting them', async () => {
  const f = setup();
  await f.scanner.cycle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].addr, address);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].price, 2);
  assert.equal(f.records[0].marketCap, 200000);
  assert.notEqual(f.records[0].status, 'X_REVIEW');
  assert.ok(f.calls[0].options.deadline > 0);
});

test('initially rejected discovery is captured and dedicated watch audit stays within cycle limit', async () => {
  const f = setup({ limit: 1, discovered: [{ address: freshAddress, market_cap: 999999 }] });
  await f.scanner.cycle();
  assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0][1][0].screen.pass, false);
  assert.ok(f.captures[0][1][0].screen.reasons.length > 0);
  assert.equal(f.calls.length, 1);
});

test('paused watch pool does not issue audits', async () => {
  const f = setup({ paused: true });
  await f.scanner.cycle();
  assert.equal(f.calls.length, 0);
});

test('watch errors are recorded for later retry, not dropped', async () => {
  const f = setup();
  f.gmgn.audit = async () => { throw Object.assign(new Error('temporary failure'), { code: 'GMGN_TIMEOUT' }); };
  await f.scanner.cycle();
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].status, 'WAIT_RECHECK');
  assert.ok(f.records[0].auditError);
});

test('credential change during a watch audit does not write its result', async () => {
  const f = setup();
  const original = f.gmgn.audit;
  f.gmgn.audit = async (...args) => { const result = await original(...args); f.gmgn.keyEpoch++; return result; };
  await f.scanner.cycle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.length, 0);
});

test('watch sampling continues on discovery network failure without claiming a healthy cycle', async () => {
  const f = setup();
  f.gmgn.discover = async () => { throw Object.assign(new Error('network failure'), { code: 'GMGN_NETWORK_ERROR' }); };
  await f.scanner.cycle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.length, 1);
  assert.equal(f.state.value.status, 'DEGRADED');
  assert.equal(f.state.value.sourceHealth.discovery.complete, false);
});

test('watch-only missing fresh metrics stay unknown rather than using old candidate prices', async () => {
  const f = setup();
  f.state.value.candidates = [{ address, chain: 'robinhood', status: 'X_REVIEW', price: 999, marketCap: 999999, liquidity: 88888, auditedAt: Date.now() }];
  f.gmgn.audit = async () => ({ info: {}, security: {}, pool: {}, holders: [], traders: [], candles: [], _meta: { complete: false } });
  await f.scanner.cycle();
  assert.equal(f.records[0].price, null);
  assert.equal(f.records[0].marketCap, null);
  assert.equal(f.records[0].liquidity, null);
});

test('paused entries also skip normal candidate and favorite monitor scheduling', async () => {
  const f = setup({ paused: true });
  f.scanner.watchPool.snapshot = () => [{ chain: 'robinhood', address, paused: true }];
  f.state.value.candidates = [{ address, chain: 'robinhood', status: 'X_REVIEW', price: 4, auditedAt: Date.now() }];
  await f.scanner.cycle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.records.length, 0);
});

test('all pool histories reject stale fallback metrics even when no dedicated watch slot is due', async () => {
  const f = setup({ paused: true });
  f.state.value.candidates = [{ address, chain: 'robinhood', status: 'X_REVIEW', price: 4, marketCap: 999999, liquidity: 88888, auditedAt: Date.now() }];
  f.gmgn.audit = async () => ({ info: {}, security: {}, pool: {}, holders: [], traders: [], candles: [], _meta: { complete: false } });
  await f.scanner.cycle();
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].price, null);
  assert.equal(f.records[0].marketCap, null);
  assert.equal(f.records[0].liquidity, null);
});
