import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchPool } from '../src/watch-pool.mjs';
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, pool: new WatchPool(dir, { now: () => 1000, ...options }) };
}
const screened = n => ({ row: { address: address(n), symbol: `T${n}`, raw: { secret: true } }, screen: { pass: false, reasons: ['市值不在范围'] } });
test('manual entries validate, normalize, persist pause and never treat reports as verified risk', t => {
  const { dir, pool } = fixture(t);
  assert.throws(() => pool.add({ chain: 'unknown', address: address(1) }));
  assert.throws(() => pool.add({ chain: 'robinhood', address: '../bad' }));
  assert.throws(() => pool.add({ chain: 'robinhood', address: address(1), label: 'x'.repeat(81) }));
  assert.throws(() => pool.add({ chain: 'robinhood', address: address(1), reportedOutcome: 'SAFE' }));
  pool.add({ chain: 'robinhood', address: address(1), reportedOutcome: 'USER_REPORTED_RUG' });
  assert.equal(pool.snapshot()[0].riskLatched, false);
  pool.setPaused({ chain: 'robinhood', address: address(1), paused: true });
  const restored = new WatchPool(dir);
  assert.equal(restored.snapshot()[0].paused, true);
  assert.equal(restored.snapshot()[0].source, 'manual');
  assert.deepEqual(restored.due('robinhood', 1e10), []);
});
test('capture preserves rejection reasons, hides raw data and protects existing and pinned rows from batch churn', t => {
  const { pool } = fixture(t, { maxEntries: 3 });
  pool.add({ chain: 'robinhood', address: address(1) });
  pool.capture('robinhood', [screened(2), screened(3)], 2000);
  pool.capture('robinhood', [screened(4), screened(5), screened(3)], 2000 + 86400000);
  assert.deepEqual(pool.snapshot().map(x => x.address).sort(), [address(1), address(3), address(4)]);
  assert.deepEqual(pool.snapshot().find(x => x.address === address(3)).latest.reasons, ['市值不在范围']);
  assert.equal(JSON.stringify(pool.snapshot()).includes('secret'), false);
  const copy = pool.snapshot(); copy[0].paused = true;
  assert.equal(pool.snapshot()[0].paused, false);
});
test('rechecks use staged intervals, fair ordering, bounded history and permanent risk latch', t => {
  const { pool } = fixture(t);
  pool.capture('robinhood', [screened(1), screened(2)], 1000);
  const candidate = { chain: 'robinhood', address: address(1), status: 'WAIT_RECHECK', deep: { failed: ['tax'] }, price: 1 };
  pool.record(candidate, 2000);
  assert.equal(pool.snapshot()[0].nextCheckAt, 122000);
  assert.equal(pool.due('robinhood', 200000)[0].address, address(2));
  pool.record(candidate, 3000);
  assert.equal(pool.snapshot()[0].nextCheckAt, 303000);
  pool.record(candidate, 4000);
  assert.equal(pool.snapshot()[0].nextCheckAt, 904000);
  pool.record({ ...candidate, status: 'HARD_REJECT', secondary: { security: { verdict: 'FATAL' } } }, 5000);
  for (let i = 0; i < 22; i++) pool.record({ ...candidate, status: 'X_REVIEW' }, 6000 + i);
  const item = pool.snapshot()[0];
  assert.equal(item.riskLatched, true);
  assert.equal(item.latest.status, 'X_REVIEW');
  assert.equal(item.nextCheckAt, 6021 + 3600000);
  assert.equal(item.history.length, 20);
});
test('seven day inactive automatic records expire while manual entries survive', t => {
  const { pool } = fixture(t);
  pool.add({ chain: 'robinhood', address: address(1) });
  pool.capture('robinhood', [screened(2)], 1000);
  pool.capture('robinhood', [], 1000 + 8 * 86400000);
  assert.deepEqual(pool.snapshot().map(x => x.address), [address(1)]);
});
test('automatic entries can become manual and full pinned pool rejects new manual entries', t => {
  const { pool } = fixture(t, { maxEntries: 1 });
  pool.capture('robinhood', [screened(1)], 1000);
  pool.add({ chain: 'robinhood', address: address(1), label: 'follow' });
  pool.capture('robinhood', [screened(2)], 2000);
  assert.equal(pool.snapshot()[0].label, 'follow');
  assert.throws(() => pool.add({ chain: 'robinhood', address: address(2) }), /limit/);
});
test('backup recovery preserves entries and unreadable state never silently resets', t => {
  const { dir, pool } = fixture(t);
  pool.add({ chain: 'robinhood', address: address(1) });
  pool.setPaused({ chain: 'robinhood', address: address(1), paused: true });
  fs.writeFileSync(path.join(dir, 'watch-pool.json'), '{broken');
  assert.equal(new WatchPool(dir).snapshot().length, 1);
  fs.writeFileSync(path.join(dir, 'watch-pool.json.bak'), '{broken');
  assert.throws(() => new WatchPool(dir), { code: 'STATE_CORRUPT' });
});
test('honeypot evidence latches risk and errors retain a scheduled retry without raw audit data', t => {
  const { pool } = fixture(t);
  pool.add({ chain: 'robinhood', address: address(1) });
  pool.record({ chain: 'robinhood', address: address(1), status: 'WAIT_RECHECK', deep: { security: { honeypot: true } },
    auditError: 'timeout', raw: { secret: true } }, 1000);
  const item = pool.snapshot()[0];
  assert.equal(item.riskLatched, true);
  assert.equal(item.latest.error, 'timeout');
  assert.equal(item.nextCheckAt, 3601000);
  assert.equal(JSON.stringify(item).includes('secret'), false);
});

test('dynamic hard rejects back off without permanently preventing recovery', t => {
  const { pool } = fixture(t);
  pool.add({ chain: 'robinhood', address: address(1) });
  pool.record({ chain: 'robinhood', address: address(1), status: 'HARD_REJECT', deep: { failed: ['liquidity', 'concentration'] } }, 1000);
  assert.equal(pool.snapshot()[0].riskLatched, false);
  assert.equal(pool.snapshot()[0].nextCheckAt, 3601000);
  pool.record({ chain: 'robinhood', address: address(1), status: 'X_REVIEW', deep: { failed: [] } }, 3601000);
  assert.equal(pool.snapshot()[0].riskLatched, false);
  assert.equal(pool.snapshot()[0].nextCheckAt, 3901000);
  assert.equal(pool.snapshot()[0].latest.status, 'X_REVIEW');
});
test('latched risk survives expiry and capacity pressure including manual additions', t => {
  const { pool } = fixture(t, { maxEntries: 1 });
  pool.capture('robinhood', [screened(1)], 1000);
  pool.record({ chain: 'robinhood', address: address(1), status: 'HARD_REJECT', deep: { security: { honeypot: true } } }, 2000);
  pool.capture('robinhood', [screened(2)], 1000 + 8 * 86400000);
  assert.equal(pool.snapshot().length, 1);
  assert.equal(pool.snapshot()[0].address, address(1));
  assert.equal(pool.snapshot()[0].riskLatched, true);
  assert.throws(() => pool.add({ chain: 'robinhood', address: address(3) }), /limit/);
});
test('automatic entries retain a first day opportunity for three checks under capacity pressure', t => {
  const { pool } = fixture(t, { maxEntries: 1 });
  pool.capture('robinhood', [screened(1)], 1000);
  pool.capture('robinhood', [screened(2)], 2000);
  assert.equal(pool.snapshot()[0].address, address(1));
  assert.throws(() => pool.add({ chain: 'robinhood', address: address(2) }), /limit/);
  for (let i = 0; i < 3; i++) pool.record({ chain: 'robinhood', address: address(1), status: 'WAIT_RECHECK' }, 3000 + i);
  pool.capture('robinhood', [screened(2)], 4000);
  assert.equal(pool.snapshot()[0].address, address(2));
  pool.capture('robinhood', [screened(3)], 4000 + 86400000);
  assert.equal(pool.snapshot()[0].address, address(3));
});
test('pause prevents in-flight audit completion from mutating history and schedule', t => {
  const { pool } = fixture(t);
  pool.add({ chain: 'robinhood', address: address(1) });
  pool.setPaused({ chain: 'robinhood', address: address(1), paused: true });
  const before = pool.snapshot()[0];
  assert.equal(pool.record({ chain: 'robinhood', address: address(1), status: 'WAIT_RECHECK' }, 5000), null);
  assert.deepEqual(pool.snapshot()[0], before);
});

test('optional Nansen evidence persists without raw fields and does not change the primary verdict', t => {
  const { dir, pool } = fixture(t);
  pool.add({chain:'robinhood',address:address(1)});
  pool.record({chain:'robinhood',address:address(1),status:'WAIT_RECHECK',nansen:{source:'NANSEN',status:'OK',checkedAt:1000,
    apiKey:'never-export',raw:{secret:true},hasMore:true,holders:[{address:address(2),label:'Exchange',valueUsd:null,raw:'secret'}]}});
  const row = new WatchPool(dir).snapshot()[0];
  assert.equal(row.latest.nansen.status,'OK');
  assert.equal(row.history[0].nansen.holders[0].valueUsd,null);
  assert.equal(row.latest.status,'WAIT_RECHECK');
  assert.equal(JSON.stringify(row).includes('never-export'),false);
  assert.equal(JSON.stringify(row).includes('secret'),false);
});
