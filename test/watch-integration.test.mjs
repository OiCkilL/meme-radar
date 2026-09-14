import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { WatchPool } from '../src/watch-pool.mjs';
import { RadarState } from '../src/state.mjs';
import { Scanner } from '../src/scanner.mjs';

test('persisted manual address receives second and third audits across restarts despite empty discovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const address = '0x' + 'a'.repeat(40);
  new WatchPool(dir).add({ chain: 'robinhood', address, reportedOutcome: 'USER_REPORTED_GRADUATED' });
  let calls = 0;
  const gmgn = { keyEpoch: 0, metrics: {}, configured: async () => true, discover: async () => [],
    audit: async () => ({ info: { price: { price: ++calls }, circulating_supply: 100000, liquidity: 10000 },
      security: {}, pool: {}, holders: [], traders: [], candles: [], _meta: { complete: true } }) };
  for (const wait of [0, 120000, 300000]) {
    t.mock.timers.tick(wait);
    const pool = new WatchPool(dir);
    const state = new RadarState(dir);
    const scanner = new Scanner({ gmgn, state, watchPool: pool, settings: { ...config, maxDeepAuditsPerCycle: 1 } });
    await scanner.cycle();
    assert.notEqual(state.value.candidates[0].status, 'X_REVIEW');
  }
  const row = new WatchPool(dir).snapshot('robinhood')[0];
  assert.equal(calls, 3);
  assert.equal(row.checkCount, 3);
  assert.equal(row.history.length, 3);
  assert.deepEqual(row.history.map(entry => entry.price), [1, 2, 3]);
  assert.equal(row.nextCheckAt, Date.now() + 900000);
  assert.equal(row.reportedOutcome, 'USER_REPORTED_GRADUATED');
  assert.equal(row.riskLatched, false);
});
