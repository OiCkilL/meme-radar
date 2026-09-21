import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GmgnClient } from '../src/gmgn.mjs';
import { WatchPool } from '../src/watch-pool.mjs';
import { RequestBudget, OBSERVE_RESERVE } from '../src/request-budget.mjs';

const address = '0x' + 'a'.repeat(40);

test('observe reads only token info and returns whitelist fields', async () => {
  const client = new GmgnClient();
  const seen = [];
  client.cachedRead = async (args, ttl, options) => {
    seen.push({ args, options });
    return {
      data: {
        price: { price: 1.25 },
        market_cap: 42000,
        liquidity: 9000,
        pool_id: 'pool-1',
        status: 'tradable'
      }
    };
  };
  const budget = new RequestBudget({
    windowMs: 60_000,
    limits: { AUDIT: { requests: 10, weight: 20 }, DISCOVERY: { requests: 1, weight: 1 }, OUTCOME: { requests: 1, weight: 1 }, LIVE: { requests: 1, weight: 1 } },
    now: () => 1000
  });
  const ticket = budget.reserve('AUDIT', OBSERVE_RESERVE);
  const result = await client.observe(address, 'robinhood', { deadline: Date.now() + 5000, budgetTicket: ticket });
  budget.release(ticket);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args.slice(0, 2), ['token', 'info']);
  assert.equal(result.source, 'GMGN_INFO');
  assert.equal(result.price, 1.25);
  assert.equal(result.marketCap, 42000);
  assert.equal(result.liquidity, 9000);
  assert.equal(result.poolId, 'pool-1');
  assert.equal(result.status, 'tradable');
  assert.equal(result.holders, undefined);
  assert.equal(result.security, undefined);
});

test('observe failure keeps prior observation and records attempt without refreshing safety', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-watch-'));
  const pool = new WatchPool(dir, { now: () => 5_000 });
  pool.add({ chain: 'robinhood', address, label: 'demo' });
  const before = pool.record({
    chain: 'robinhood', address, status: 'X_REVIEW',
    price: 1, marketCap: 10, liquidity: 20, deep: { failed: [], chainPass: true }
  }, 5_000);
  assert.equal(before.checkCount, 1);

  pool.recordObservation({
    chain: 'robinhood',
    address,
    observation: { source: 'GMGN_INFO', observedAt: 6_000, collectedAt: 6_000, price: 2, marketCap: 20, liquidity: 30, poolId: null, status: null },
    nextObservationAt: 6_000 + 120_000
  });
  const mid = pool.snapshot('robinhood')[0];
  assert.equal(mid.observationCount, 1);
  assert.equal(mid.checkCount, 1);
  assert.equal(mid.latest.status, 'X_REVIEW');
  assert.equal(mid.lastObservation.price, 2);
  assert.equal(mid.nextCheckAt, before.nextCheckAt);

  pool.recordObservationFailure({
    chain: 'robinhood',
    address,
    error: 'GMGN_TIMEOUT',
    at: 7_000,
    nextObservationAt: 7_000 + 60_000
  });
  const after = pool.snapshot('robinhood')[0];
  assert.equal(after.lastObservation.price, 2);
  assert.equal(after.latest.status, 'X_REVIEW');
  assert.equal(after.checkCount, 1);
  assert.equal(after.lastObservationError?.code, 'GMGN_TIMEOUT');
  assert.ok(after.nextObservationAt >= 7_000);
  assert.equal(after.riskLatched, false);
});

test('observe never pretends to clear riskLatched or bump reviewRevision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-risk-'));
  const pool = new WatchPool(dir, { now: () => 1_000 });
  pool.add({ chain: 'robinhood', address });
  const item = pool.entries.get(`robinhood:${address}`);
  item.riskLatched = true;
  item.latest = { at: 1_000, status: 'HARD_REJECT', reasons: ['honeypot'], price: 1, marketCap: 1, liquidity: 1, error: '' };
  item.checkCount = 2;
  pool.save();

  pool.recordObservation({
    chain: 'robinhood',
    address,
    observation: { source: 'GMGN_INFO', observedAt: 2_000, collectedAt: 2_000, price: 9, marketCap: 90, liquidity: 900, poolId: null, status: 'ok' },
    nextObservationAt: 3_000
  });
  const row = pool.snapshot('robinhood')[0];
  assert.equal(row.riskLatched, true);
  assert.equal(row.latest.status, 'HARD_REJECT');
  assert.equal(row.checkCount, 2);
  assert.equal(row.lastObservation.price, 9);
});
