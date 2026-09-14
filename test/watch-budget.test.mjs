import test from 'node:test';
import assert from 'node:assert/strict';
import { GmgnClient } from '../src/gmgn.mjs';

test('audit propagates cycle deadline through cache reads to queued provider calls', async () => {
  const client = new GmgnClient();
  const seen = [];
  client.run = async (args, options) => { seen.push(options?.deadline); return {}; };
  const deadline = Date.now() + 60000;
  await client.audit('0x' + '1'.repeat(40), 1800000000, 'robinhood', { deadline });
  assert.equal(seen.length, 6);
  assert.ok(seen.every(value => value === deadline));
});

test('expired cycle does not queue provider calls even for a cached audit', async () => {
  const client = new GmgnClient();
  let calls = 0;
  client.run = async () => { calls++; return {}; };
  await assert.rejects(client.audit('0x' + '1'.repeat(40), 1800000000, 'robinhood', { deadline: Date.now() - 1 }), { code: 'GMGN_TIMEOUT' });
  assert.equal(calls, 0);
});

test('a paced request whose wait exceeds deadline fails before sleeping or counting a request', async () => {
  const client = new GmgnClient({ minRequestGapMs: 1000 });
  client.lastRequestAt = Date.now();
  client.lastWeight = 5;
  const start = Date.now();
  await assert.rejects(client.runNow(['token', 'info'], { deadline: start + 25 }), { code: 'GMGN_TIMEOUT' });
  assert.equal(client.metrics.requests, 0);
  assert.ok(Date.now() - start < 1000, 'deadline must bound the pacing wait too');
});
