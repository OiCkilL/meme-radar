import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RadarState } from '../src/state.mjs';
import { WatchPool } from '../src/watch-pool.mjs';
import { SupplementQueue } from '../src/supplement-queue.mjs';
import { SecondaryValidator } from '../src/secondary.mjs';
import { config } from '../src/config.mjs';
import { Scanner } from '../src/scanner.mjs';

const address = '0x' + 'b'.repeat(40);
const other = '0x' + 'c'.repeat(40);

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sp04-'));
}

test('commitCandidate publishes first token while second audit is still hanging', async () => {
  const dir = temp();
  const state = new RadarState(dir);
  const watchPool = new WatchPool(dir);
  watchPool.add({ chain: 'robinhood', address });
  watchPool.add({ chain: 'robinhood', address: other });
  let releaseSecond;
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let audits = 0;
  const gmgn = {
    keyEpoch: 0,
    metrics: {},
    nextAllowedAt: 0,
    disabled: false,
    configured: async () => true,
    discover: async () => [],
    audit: async (addr) => {
      audits += 1;
      if (addr === other) await secondGate;
      return {
        info: { price: { price: 1 }, market_cap: 50_000, circulating_supply: 50_000, liquidity: 10_000 },
        security: { is_honeypot: false },
        pool: { liquidity: 10_000 },
        holders: [], traders: [], candles: [],
        _meta: { complete: true }
      };
    }
  };
  const scanner = new Scanner({
    gmgn, state, watchPool,
    settings: { ...config, throughputEnabled: true, maxDeepAuditsPerCycle: 2, auditCycleBudgetMs: 30_000, outcomeReadsPerCycle: 1 }
  });
  // Seed due deep work for both.
  for (const row of watchPool.snapshot('robinhood')) {
    const item = watchPool.entries.get(`robinhood:${row.address}`);
    item.nextCheckAt = 0;
    item.source = 'manual';
    item.forceDeepReview = true;
  }
  watchPool.save();

  const cycling = scanner.cycle();
  await delay(50);
  assert.ok(state.value.candidates?.some(row => row.address === address) || watchPool.snapshot('robinhood').find(r => r.address === address)?.checkCount >= 1
    || state.value.revision > 0 || watchPool.entries.get(`robinhood:${address}`)?.checkCount >= 1);
  // Prefer watch evidence: first deep should have committed.
  assert.ok(watchPool.entries.get(`robinhood:${address}`)?.checkCount >= 1, 'first token deep must commit before second finishes');
  releaseSecond();
  await cycling;
  assert.equal(audits, 2);
});

test('attachSupplement is idempotent by reviewId and does not bump checkCount', () => {
  const dir = temp();
  const pool = new WatchPool(dir, { now: () => 1000 });
  pool.add({ chain: 'robinhood', address });
  pool.record({
    chain: 'robinhood', address, status: 'WAIT_RECHECK', reviewId: 'rev-1',
    price: 1, marketCap: 1, liquidity: 1, deep: { failed: [] }
  }, 1000);
  assert.equal(pool.snapshot('robinhood')[0].checkCount, 1);
  const once = pool.attachSupplement({
    chain: 'robinhood', address, reviewId: 'rev-1',
    supplement: { source: 'NANSEN', status: 'OK', checkedAt: 1100, sampled: true, sampleCount: 0, hasMore: false, holders: [] }
  });
  const twice = pool.attachSupplement({
    chain: 'robinhood', address, reviewId: 'rev-1',
    supplement: { source: 'NANSEN', status: 'OK', checkedAt: 1200, sampled: true, sampleCount: 0, hasMore: false, holders: [] }
  });
  assert.equal(once.attached, true);
  assert.equal(twice.attached, true);
  const row = pool.snapshot('robinhood')[0];
  assert.equal(row.checkCount, 1);
  assert.equal(row.latest.nansen.status, 'OK');
  assert.equal(row.latest.reviewId, 'rev-1');
});

test('stale reviewId supplement is dropped without creating pseudo deep', () => {
  const dir = temp();
  const pool = new WatchPool(dir, { now: () => 1000 });
  pool.add({ chain: 'robinhood', address });
  pool.record({ chain: 'robinhood', address, status: 'WAIT_RECHECK', reviewId: 'old', deep: { failed: [] } }, 1000);
  pool.record({ chain: 'robinhood', address, status: 'WAIT_RECHECK', reviewId: 'new', deep: { failed: [] } }, 2000);
  const result = pool.attachSupplement({
    chain: 'robinhood', address, reviewId: 'missing',
    supplement: { source: 'NANSEN', status: 'OK', checkedAt: 3000, sampled: true, sampleCount: 0, hasMore: false, holders: [] }
  });
  assert.equal(result.attached, false);
  assert.equal(pool.snapshot('robinhood')[0].checkCount, 2);
  assert.equal(pool.snapshot('robinhood')[0].latest.nansen, null);
});

test('Nansen hanging 5s still allows first GMGN candidate publish via supplement queue', async () => {
  const dir = temp();
  const state = new RadarState(dir);
  const watchPool = new WatchPool(dir);
  watchPool.add({ chain: 'robinhood', address });
  const item = watchPool.entries.get(`robinhood:${address}`);
  item.nextCheckAt = 0;
  item.source = 'manual';
  watchPool.save();

  let nansenStarted = 0;
  const gmgn = {
    keyEpoch: 0, metrics: {}, nextAllowedAt: 0, disabled: false,
    configured: async () => true,
    discover: async () => [],
    audit: async () => ({
      info: { price: { price: 1 }, market_cap: 50_000, liquidity: 10_000 },
      security: {}, pool: { liquidity: 10_000 }, holders: [], traders: [], candles: [],
      _meta: { complete: true }
    })
  };
  const nansen = {
    snapshot: () => ({ enabled: true, configured: true }),
    canReview: () => true,
    revision: 1,
    review: async () => {
      nansenStarted += 1;
      await delay(5_000);
      return { source: 'NANSEN', status: 'OK', checkedAt: Date.now(), sampled: true, sampleCount: 0, hasMore: false, holders: [] };
    }
  };
  const supplements = new SupplementQueue({ nansen, watchPool, state, now: Date.now });
  const scanner = new Scanner({
    gmgn, nansen, watchPool, state, supplements,
    settings: { ...config, throughputEnabled: true, maxDeepAuditsPerCycle: 1, auditCycleBudgetMs: 20_000, outcomeReadsPerCycle: 1 }
  });
  const started = Date.now();
  await scanner.cycle();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `cycle must not await Nansen, took ${elapsed}ms`);
  assert.ok(watchPool.entries.get(`robinhood:${address}`)?.checkCount >= 1);
  assert.equal(nansenStarted, 1);
  await supplements.flush(6_000);
  assert.equal(watchPool.snapshot('robinhood')[0].latest?.nansen?.status, 'OK');
  supplements.dispose();
});

test('secondary validate respects remaining deadline under 1s budget', async () => {
  const started = Date.now();
  const fetchImpl = async () => {
    await delay(8_000);
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '[]'
    };
  };
  const secondary = new SecondaryValidator({ fetchImpl, timeoutMs: 8_000 });
  const result = await secondary.validate({
    chain: 'bsc',
    tokenAddress: address,
    primary: {},
    deadline: Date.now() + 200
  });
  assert.ok(Date.now() - started < 1500);
  assert.equal(result.complete, false);
  assert.ok(['DEGRADED', 'COMPLETE'].includes(result.status));
  assert.notEqual(result.security?.verdict, 'PASS');
});
