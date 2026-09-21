import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RequestBudget,
  auditEnvelope,
  DEEP_RESERVE,
  OBSERVE_RESERVE
} from '../src/request-budget.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'request-budget-'));
}

test('AUDIT envelope is shared across chains for W/M defaults', () => {
  const env = auditEnvelope({ scanIntervalMs: 120_000, maxDeepAuditsPerCycle: 6, enabledChains: 3 });
  assert.equal(env.AUDIT.requests, 36);
  assert.equal(env.AUDIT.weight, 90);
  assert.equal(env.DISCOVERY.requests, 6);
  assert.equal(env.DISCOVERY.weight, 12);
  assert.equal(env.OUTCOME.requests, 4);
  assert.equal(env.OUTCOME.weight, 8);
  assert.equal(env.LIVE.requests, 6);
  assert.equal(env.LIVE.weight, 6);
});

test('reserve tickets charge dual counters and release unused only', () => {
  let now = 1_000_000;
  const budget = new RequestBudget({
    windowMs: 120_000,
    limits: auditEnvelope({ scanIntervalMs: 120_000, maxDeepAuditsPerCycle: 6, enabledChains: 1 }),
    now: () => now
  });
  const ticket = budget.reserve('AUDIT', DEEP_RESERVE);
  assert.equal(ticket.reservedRequests, 6);
  assert.equal(ticket.reservedWeight, 15);
  assert.equal(budget.remaining('AUDIT').requests, 30);
  assert.equal(budget.remaining('AUDIT').weight, 75);

  budget.consume(ticket, { requests: 1, weight: 1 });
  budget.consume(ticket, { requests: 1, weight: 5 });
  budget.release(ticket);
  assert.equal(budget.spent('AUDIT').requests, 2);
  assert.equal(budget.spent('AUDIT').weight, 6);
  assert.equal(budget.remaining('AUDIT').requests, 34);
  assert.equal(budget.remaining('AUDIT').weight, 84);
});

test('cache hits do not charge; dispatched timeouts still charge; unsent tickets refund', () => {
  const budget = new RequestBudget({
    windowMs: 60_000,
    limits: { AUDIT: { requests: 10, weight: 20 }, DISCOVERY: { requests: 2, weight: 4 }, OUTCOME: { requests: 2, weight: 4 }, LIVE: { requests: 1, weight: 1 } },
    now: () => 50
  });
  const ticket = budget.reserve('AUDIT', OBSERVE_RESERVE);
  budget.noteCacheHit(ticket);
  assert.equal(budget.spent('AUDIT').requests, 0);
  budget.consume(ticket, { requests: 1, weight: 1, dispatched: true });
  budget.release(ticket);
  assert.equal(budget.spent('AUDIT').requests, 1);

  const unused = budget.reserve('AUDIT', DEEP_RESERVE);
  budget.release(unused);
  assert.equal(budget.spent('AUDIT').requests, 1);
  assert.equal(budget.remaining('AUDIT').requests, 9);
});

test('OUTCOME and LIVE cannot steal AUDIT reserved capacity', () => {
  const budget = new RequestBudget({
    windowMs: 60_000,
    limits: { AUDIT: { requests: 6, weight: 15 }, DISCOVERY: { requests: 2, weight: 4 }, OUTCOME: { requests: 4, weight: 8 }, LIVE: { requests: 2, weight: 2 } },
    now: () => 1
  });
  budget.reserve('AUDIT', DEEP_RESERVE);
  assert.equal(budget.canReserve('OUTCOME', { requests: 1, weight: 2 }), true);
  assert.equal(budget.remaining('AUDIT').requests, 0);
  assert.throws(() => budget.reserve('AUDIT', OBSERVE_RESERVE), { code: 'SKIPPED_BUDGET' });
});

test('ledger persists spent counts without keys and survives key swap', () => {
  const dir = tempDir();
  let now = 10_000;
  const budget = new RequestBudget({
    windowMs: 120_000,
    limits: auditEnvelope({ scanIntervalMs: 120_000, maxDeepAuditsPerCycle: 2, enabledChains: 1 }),
    now: () => now,
    file: path.join(dir, 'request-budget.json')
  });
  const ticket = budget.reserve('AUDIT', OBSERVE_RESERVE);
  budget.consume(ticket, { requests: 1, weight: 1 });
  budget.release(ticket);
  budget.persist();

  const restored = new RequestBudget({
    windowMs: 120_000,
    limits: auditEnvelope({ scanIntervalMs: 120_000, maxDeepAuditsPerCycle: 2, enabledChains: 1 }),
    now: () => now,
    file: path.join(dir, 'request-budget.json')
  });
  assert.equal(restored.spent('AUDIT').requests, 1);
  assert.equal(restored.spent('AUDIT').weight, 1);
  assert.equal(JSON.stringify(restored.snapshot()).includes('apiKey'), false);
  assert.equal(JSON.stringify(restored.snapshot()).includes('GMGN'), false);
});

test('corrupt ledger waits one full window before spending again', () => {
  const dir = tempDir();
  const file = path.join(dir, 'request-budget.json');
  fs.writeFileSync(file, '{not-json');
  let now = 1_000;
  const budget = new RequestBudget({
    windowMs: 50_000,
    limits: auditEnvelope({ scanIntervalMs: 50_000, maxDeepAuditsPerCycle: 1, enabledChains: 1 }),
    now: () => now,
    file
  });
  assert.equal(budget.ledgerError, 'CORRUPT_LEDGER');
  assert.throws(() => budget.reserve('AUDIT', OBSERVE_RESERVE), { code: 'SKIPPED_BUDGET' });
  now = 1_000 + 50_000;
  const ticket = budget.reserve('AUDIT', OBSERVE_RESERVE);
  assert.equal(ticket.reservedRequests, 1);
});

test('clock rollback does not enlarge the rolling window budget', () => {
  let now = 200_000;
  const budget = new RequestBudget({
    windowMs: 100_000,
    limits: { AUDIT: { requests: 4, weight: 10 }, DISCOVERY: { requests: 1, weight: 1 }, OUTCOME: { requests: 1, weight: 1 }, LIVE: { requests: 1, weight: 1 } },
    now: () => now
  });
  const a = budget.reserve('AUDIT', OBSERVE_RESERVE);
  budget.consume(a, { requests: 1, weight: 1 });
  budget.release(a);
  now = 50_000;
  const b = budget.reserve('AUDIT', OBSERVE_RESERVE);
  budget.consume(b, { requests: 1, weight: 1 });
  budget.release(b);
  assert.ok(budget.spent('AUDIT').requests <= 4);
  assert.equal(budget.remaining('AUDIT').requests < 4, true);
});

test('auth verification is counted physically but does not consume AUDIT quota', () => {
  const budget = new RequestBudget({
    windowMs: 60_000,
    limits: { AUDIT: { requests: 1, weight: 1 }, DISCOVERY: { requests: 1, weight: 1 }, OUTCOME: { requests: 1, weight: 1 }, LIVE: { requests: 1, weight: 1 } },
    now: () => 1
  });
  budget.recordPhysical({ family: 'AUTH', requests: 1, weight: 1 });
  assert.equal(budget.spent('AUDIT').requests, 0);
  assert.equal(budget.metrics().physicalRequests, 1);
  const ticket = budget.reserve('AUDIT', OBSERVE_RESERVE);
  assert.ok(ticket);
});
