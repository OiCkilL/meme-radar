import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLane,
  classifyModeEligibility,
  migrateWatchEntry,
  selectFairTasks,
  advanceModeCursor,
  hashSpread
} from '../src/audit-scheduler.mjs';

const addr = (n) => '0x' + String(n).padStart(40, '0');

test('lanes: risk / manual / discovery / recheck', () => {
  assert.equal(classifyLane({ riskLatched: true, source: 'manual' }), 'RISK');
  assert.equal(classifyLane({ source: 'manual', riskLatched: false }), 'MANUAL');
  assert.equal(classifyLane({ favorite: true }), 'MANUAL');
  assert.equal(classifyLane({ source: 'discovery', checkCount: 0, status: 'DISCOVERY_PASS' }), 'DISCOVERY');
  assert.equal(classifyLane({ source: 'discovery', checkCount: 2, status: 'WAIT_RECHECK' }), 'RECHECK');
});

test('eligibility table forces DEEP for manual, passed X_REVIEW, and riskLatched', () => {
  assert.equal(classifyModeEligibility({ source: 'manual', forceDeepReview: true }).forcedDeep, true);
  assert.equal(classifyModeEligibility({ status: 'X_REVIEW', checkCount: 3 }).forcedDeep, true);
  assert.equal(classifyModeEligibility({ riskLatched: true }).forcedDeep, true);
  assert.equal(classifyModeEligibility({ status: 'DISCOVERY_REJECTED', checkCount: 0 }).allowObserve, true);
  assert.equal(classifyModeEligibility({ delisted: true, status: 'WAIT_RECHECK' }).allowObserve, true);
});

test('HARD_REJECT without clear static reasons stays conservative DEEP', () => {
  const unclear = classifyModeEligibility({
    status: 'HARD_REJECT',
    riskLatched: false,
    hardFailed: ['openSource']
  });
  assert.equal(unclear.forcedDeep, true);
  assert.equal(unclear.allowObserve, false);

  const soft = classifyModeEligibility({
    status: 'HARD_REJECT',
    riskLatched: false,
    hardFailed: ['liquidity', 'concentration']
  });
  assert.equal(soft.allowObserve, true);
  assert.equal(soft.forcedDeep, false);
});

test('fair lanes rotate under limit 1 and keep deep protection envelope', () => {
  const now = 10_000;
  const items = [
    { chain: 'robinhood', address: addr(1), lane: 'MANUAL', dueAt: now - 1, mode: 'DEEP', forcedDeep: true, key: 'robinhood:' + addr(1) },
    { chain: 'robinhood', address: addr(2), lane: 'DISCOVERY', dueAt: now - 1, mode: 'DEEP', forcedDeep: false, key: 'robinhood:' + addr(2) },
    { chain: 'robinhood', address: addr(3), lane: 'RECHECK', dueAt: now - 1, mode: 'OBSERVE', forcedDeep: false, key: 'robinhood:' + addr(3) },
    { chain: 'robinhood', address: addr(4), lane: 'RISK', dueAt: now - 1, mode: 'DEEP', forcedDeep: true, key: 'robinhood:' + addr(4) }
  ];
  const seen = [];
  let cursor = { lane: 0, mode: { RECHECK: 'OBSERVE' } };
  for (let i = 0; i < 4; i++) {
    const { selected, cursor: next } = selectFairTasks(items, {
      now,
      limit: 1,
      deepProtect: 2,
      deepBudgetLeft: 2,
      observeBudgetLeft: 10,
      cursor
    });
    assert.equal(selected.length, 1);
    seen.push(selected[0].lane);
    cursor = next;
    items.find(row => row.key === selected[0].key).dueAt = now + 999999;
  }
  assert.deepEqual(new Set(seen), new Set(['MANUAL', 'DISCOVERY', 'RECHECK', 'RISK']));
});

test('forced DEEP due prefers DEEP once; ordinary rotates via modeCursor', () => {
  const now = 5_000;
  const forced = {
    chain: 'robinhood', address: addr(9), lane: 'MANUAL', dueAt: now,
    deepDueAt: now, observeDueAt: now, forcedDeep: true, allowObserve: true,
    modeCursor: 'OBSERVE', key: 'robinhood:' + addr(9)
  };
  const { selected } = selectFairTasks([forced], {
    now, limit: 1, deepProtect: 1, deepBudgetLeft: 1, observeBudgetLeft: 1, cursor: { lane: 0, mode: {} }
  });
  assert.equal(selected[0].mode, 'DEEP');

  const ordinary = {
    chain: 'robinhood', address: addr(8), lane: 'RECHECK', dueAt: now,
    deepDueAt: now, observeDueAt: now, forcedDeep: false, allowObserve: true,
    modeCursor: 'OBSERVE', key: 'robinhood:' + addr(8)
  };
  const first = selectFairTasks([ordinary], {
    now, limit: 1, deepProtect: 0, deepBudgetLeft: 1, observeBudgetLeft: 1, cursor: { lane: 0, mode: {} }
  });
  assert.equal(first.selected[0].mode, 'OBSERVE');
  ordinary.modeCursor = advanceModeCursor(ordinary.modeCursor, 'OBSERVE');
  const second = selectFairTasks([ordinary], {
    now, limit: 1, deepProtect: 0, deepBudgetLeft: 1, observeBudgetLeft: 1, cursor: { lane: 0, mode: {} }
  });
  assert.equal(second.selected[0].mode, 'DEEP');
});

test('old schema migration spreads nextObservationAt and preserves risk clocks', () => {
  const windowMs = 120_000;
  const now = 1_000_000;
  const entry = {
    chain: 'robinhood',
    address: addr(42),
    source: 'discovery',
    riskLatched: true,
    nextCheckAt: now - 50_000,
    checkCount: 4,
    firstSeenAt: now - 86400_000
  };
  const migrated = migrateWatchEntry(entry, { now, windowMs });
  assert.equal(migrated.nextCheckAt, entry.nextCheckAt);
  assert.equal(migrated.checkCount, 4);
  assert.equal(migrated.riskLatched, true);
  assert.ok(migrated.nextObservationAt >= now);
  assert.ok(migrated.nextObservationAt < now + windowMs);
  assert.equal(migrated.modeCursor, 'DEEP');
  assert.equal(migrated.observationCount || 0, 0);
});

test('hashSpread is deterministic for tokenKey', () => {
  assert.equal(hashSpread('robinhood:' + addr(1), 120), hashSpread('robinhood:' + addr(1), 120));
  assert.notEqual(hashSpread('robinhood:' + addr(1), 120), hashSpread('robinhood:' + addr(2), 120));
});

test('paused entries are never selected', () => {
  const now = 100;
  const { selected } = selectFairTasks([{
    chain: 'robinhood', address: addr(1), lane: 'MANUAL', dueAt: now, mode: 'DEEP',
    forcedDeep: true, paused: true, key: 'robinhood:' + addr(1)
  }], { now, limit: 1, deepProtect: 1, deepBudgetLeft: 1, observeBudgetLeft: 1, cursor: { lane: 0, mode: {} } });
  assert.equal(selected.length, 0);
});
