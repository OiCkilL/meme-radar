import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchPool } from '../src/watch-pool.mjs';
import { RadarState } from '../src/state.mjs';
import { RequestBudget, auditEnvelope, DEEP_RESERVE, OBSERVE_RESERVE } from '../src/request-budget.mjs';
import {
  classifyLane,
  classifyModeEligibility,
  migrateWatchEntry,
  selectFairTasks
} from '../src/audit-scheduler.mjs';
import { Scanner } from '../src/scanner.mjs';
import { config } from '../src/config.mjs';
import { SupplementQueue } from '../src/supplement-queue.mjs';

function a(n) { return '0x' + String(n).padStart(40, '0'); }

function oldSchemaMixedBacklog(now = 1_000_000) {
  return [
    { chain: 'robinhood', address: a(1), source: 'manual', pinned: true, riskLatched: false, nextCheckAt: now - 10_000, checkCount: 1, firstSeenAt: now - 86_400_000, lastSeenAt: now - 10_000, paused: false, latest: { status: 'WAIT_RECHECK', reasons: [] }, history: [] },
    { chain: 'robinhood', address: a(2), source: 'discovery', riskLatched: true, nextCheckAt: now - 5_000, checkCount: 5, firstSeenAt: now - 200_000, lastSeenAt: now - 5_000, paused: false, latest: { status: 'HARD_REJECT', reasons: ['honeypot'] }, history: [] },
    { chain: 'robinhood', address: a(3), source: 'discovery', riskLatched: false, nextCheckAt: now - 1_000, checkCount: 3, firstSeenAt: now - 300_000, lastSeenAt: now - 1_000, paused: false, latest: { status: 'X_REVIEW', reasons: [] }, history: [] },
    { chain: 'robinhood', address: a(4), source: 'discovery', riskLatched: false, nextCheckAt: now - 2_000, checkCount: 0, firstSeenAt: now - 60_000, lastSeenAt: now - 2_000, paused: false, latest: { status: 'DISCOVERY_REJECTED', reasons: ['liquidity'] }, history: [] },
    { chain: 'robinhood', address: a(5), source: 'discovery', riskLatched: false, nextCheckAt: now - 3_000, checkCount: 2, firstSeenAt: now - 120_000, lastSeenAt: now - 90_000, paused: false, latest: { status: 'WAIT_RECHECK', reasons: ['delisted'] }, history: [], delisted: true },
    { chain: 'robinhood', address: a(6), source: 'discovery', riskLatched: false, nextCheckAt: now - 4_000, checkCount: 2, firstSeenAt: now - 150_000, lastSeenAt: now - 4_000, paused: false, latest: { status: 'WAIT_RECHECK', reasons: [] }, history: [] },
    { chain: 'robinhood', address: a(7), source: 'discovery', riskLatched: false, nextCheckAt: now - 6_000, checkCount: 1, firstSeenAt: now - 180_000, lastSeenAt: now - 6_000, paused: false, latest: { status: 'HARD_REJECT', reasons: ['openSource'] }, history: [] }
  ];
}

test('old schema mixed fixture migrates without clearing risk or inventing deep completions', () => {
  const now = 2_000_000;
  const windowMs = 120_000;
  const migrated = oldSchemaMixedBacklog(now).map(row => migrateWatchEntry(row, { now, windowMs }));
  assert.equal(migrated.length, 7);
  for (const row of migrated) {
    assert.ok(Number.isFinite(row.nextObservationAt));
    assert.ok(row.nextObservationAt >= now && row.nextObservationAt < now + windowMs);
    assert.equal(row.observationCount || 0, 0);
  }
  assert.equal(migrated[1].riskLatched, true);
  assert.equal(migrated[1].nextCheckAt, now - 5_000);
  assert.equal(migrated[1].checkCount, 5);
  assert.equal(migrated[0].modeCursor, 'DEEP');
  assert.equal(migrated[2].modeCursor, 'DEEP');
  assert.equal(migrated[3].modeCursor, 'OBSERVE');
});

test('mixed backlog fair selection keeps forced DEEP capacity and allows observe on soft subset', () => {
  const now = 3_000_000;
  const items = oldSchemaMixedBacklog(now).map(row => {
    const eligibility = classifyModeEligibility({
      ...row,
      status: row.latest?.status,
      hardFailed: row.latest?.reasons || [],
      delisted: row.delisted
    });
    return {
      ...row,
      key: `robinhood:${row.address}`,
      lane: classifyLane({ ...row, status: row.latest?.status }),
      dueAt: Math.min(row.nextCheckAt, now),
      deepDueAt: row.nextCheckAt,
      observeDueAt: now,
      forcedDeep: eligibility.forcedDeep,
      allowObserve: eligibility.allowObserve,
      modeCursor: eligibility.forcedDeep ? 'DEEP' : 'OBSERVE'
    };
  });
  const { selected } = selectFairTasks(items, {
    now,
    limit: 8,
    deepProtect: 2,
    deepBudgetLeft: 2,
    observeBudgetLeft: 6,
    cursor: { lane: 0, mode: {} }
  });
  const deep = selected.filter(row => row.mode === 'DEEP');
  const observe = selected.filter(row => row.mode === 'OBSERVE');
  assert.ok(deep.length >= 2, 'must preserve min deep protect capacity');
  assert.ok(observe.length >= 1, 'soft backlog must receive observe coverage');
  assert.ok(deep.some(row => row.address === a(1) || row.address === a(2) || row.address === a(3)));
  assert.equal(selected.filter(row => row.address === a(7) && row.mode === 'OBSERVE').length, 0);
});

test('budget race: DEEP+OBSERVE share AUDIT envelope and OUTCOME cannot overdraw reserved deep', () => {
  const budget = new RequestBudget({
    windowMs: 120_000,
    limits: auditEnvelope({ scanIntervalMs: 120_000, maxDeepAuditsPerCycle: 2, enabledChains: 1 }),
    now: () => 10
  });
  const deep = budget.reserve('AUDIT', DEEP_RESERVE);
  const observe = budget.reserve('AUDIT', OBSERVE_RESERVE);
  assert.equal(budget.remaining('AUDIT').requests, 12 - 6 - 1);
  assert.throws(() => budget.reserve('AUDIT', DEEP_RESERVE), { code: 'SKIPPED_BUDGET' });
  budget.consume(observe, { requests: 1, weight: 1 });
  budget.release(observe);
  budget.consume(deep, { requests: 2, weight: 6 });
  budget.release(deep);
  assert.equal(budget.spent('AUDIT').requests, 3);
  const outcome = budget.reserve('OUTCOME', { requests: 1, weight: 2 });
  budget.consume(outcome, { requests: 1, weight: 2 });
  budget.release(outcome);
  assert.equal(budget.spent('AUDIT').requests, 3);
});

test('throughput cycle on mixed watch fixture completes observe without holders/traders on observe path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp05-mixed-'));
  const file = path.join(dir, 'watch-pool.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ entries: oldSchemaMixedBacklog(now) }));
  const watchPool = new WatchPool(dir, { now: () => now });
  // Make light-sample due immediately for soft categories while keeping staggered migration for others.
  for (const item of watchPool.entries.values()) {
    const status = item.latest?.status;
    const soft = item.source !== 'manual' && !item.riskLatched && status !== 'X_REVIEW'
      && (status === 'DISCOVERY_REJECTED' || status === 'WAIT_RECHECK' || item.delisted);
    const unclearHard = status === 'HARD_REJECT' && !(item.latest?.reasons || []).includes('honeypot');
    if (soft && !unclearHard) item.nextObservationAt = now - 1;
  }
  watchPool.save();
  const state = new RadarState(dir);
  const calls = [];
  const gmgn = {
    keyEpoch: 0, metrics: { requests: 0 }, nextAllowedAt: 0, disabled: false,
    configured: async () => true,
    discover: async () => [],
    observe: async (address) => {
      calls.push({ type: 'observe', address });
      return { source: 'GMGN_INFO', observedAt: now, collectedAt: now, price: 1, marketCap: 10, liquidity: 20, poolId: null, status: null };
    },
    audit: async (address) => {
      calls.push({ type: 'audit', address });
      return {
        info: { price: { price: 1 }, market_cap: 50_000, liquidity: 10_000 },
        security: {}, pool: { liquidity: 10_000 }, holders: [{ id: 1 }], traders: [{ id: 1 }], candles: [],
        _meta: { complete: true }
      };
    }
  };
  const nansen = {
    snapshot: () => ({ enabled: true, configured: true }),
    canReview: () => true,
    review: async () => { calls.push({ type: 'nansen' }); return { source: 'NANSEN', status: 'OK', checkedAt: now, sampled: true, sampleCount: 0, hasMore: false, holders: [] }; }
  };
  const supplements = new SupplementQueue({ nansen, watchPool, state });
  const scanner = new Scanner({
    gmgn, nansen, watchPool, state, supplements,
    settings: { ...config, throughputEnabled: true, maxDeepAuditsPerCycle: 2, auditCycleBudgetMs: 20_000, outcomeReadsPerCycle: 1, stateDir: dir }
  });
  await scanner.cycle();
  const observeCalls = calls.filter(c => c.type === 'observe');
  const auditCalls = calls.filter(c => c.type === 'audit');
  assert.ok(observeCalls.length >= 1, 'mixed soft subset should get observe');
  assert.ok(auditCalls.length >= 1, 'forced categories should still get deep');
  const rejected = watchPool.snapshot('robinhood').find(row => row.address === a(4));
  assert.ok(rejected);
  assert.equal(rejected.checkCount, 0);
  const risk = watchPool.snapshot('robinhood').find(row => row.address === a(2));
  assert.equal(risk.riskLatched, true);
  supplements.dispose();
});

test('UI and README expose deep vs light-sample clocks and THROUGHPUT_MODE', () => {
  const html = fs.readFileSync(path.join(path.resolve('public'), 'index.html'), 'utf8');
  assert.match(html, /observationCount/);
  assert.match(html, /nextObservationAt/);
  assert.match(html, /轻采样/);
  assert.match(html, /深审/);
  const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
  assert.match(readme, /THROUGHPUT_MODE/);
  assert.match(readme, /轻采样/);
});
