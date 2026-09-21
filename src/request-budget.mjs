import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './local-store.mjs';

export const DEEP_RESERVE = Object.freeze({ requests: 6, weight: 15 });
export const OBSERVE_RESERVE = Object.freeze({ requests: 1, weight: 1 });

const FAMILIES = Object.freeze(['AUDIT', 'DISCOVERY', 'OUTCOME', 'LIVE', 'AUTH']);

export function auditEnvelope({
  scanIntervalMs = 120_000,
  maxDeepAuditsPerCycle = 6,
  outcomeReadsPerCycle = 4,
  enabledChains = 1
} = {}) {
  const W = Math.max(1, Number(scanIntervalMs) || 120_000);
  const M = Math.max(1, Number(maxDeepAuditsPerCycle) || 6);
  const R = Math.max(1, Number(outcomeReadsPerCycle) || 4);
  const C = Math.max(1, Math.min(3, Number(enabledChains) || 1));
  const L = Math.ceil(W / 20_000);
  return Object.freeze({
    AUDIT: Object.freeze({ requests: 6 * M, weight: 15 * M }),
    DISCOVERY: Object.freeze({ requests: 2 * C, weight: 4 * C }),
    OUTCOME: Object.freeze({ requests: R, weight: 2 * R }),
    LIVE: Object.freeze({ requests: L, weight: L })
  });
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function emptySpent() {
  return Object.fromEntries(FAMILIES.map(name => [name, { requests: 0, weight: 0 }]));
}

function emptyReserved() {
  return Object.fromEntries(['AUDIT', 'DISCOVERY', 'OUTCOME', 'LIVE'].map(name => [name, { requests: 0, weight: 0 }]));
}

export class RequestBudget {
  constructor({
    windowMs = 120_000,
    limits = auditEnvelope(),
    now = Date.now,
    file = null
  } = {}) {
    this.windowMs = Math.max(1, finite(windowMs, 120_000));
    this.limits = {
      AUDIT: { ...limits.AUDIT },
      DISCOVERY: { ...limits.DISCOVERY },
      OUTCOME: { ...limits.OUTCOME },
      LIVE: { ...limits.LIVE }
    };
    this.now = now;
    this.file = file;
    this.ledgerError = '';
    this.enabledAt = this.now();
    this.entries = [];
    this.reserved = emptyReserved();
    this.physicalTotal = 0;
    this.cacheHits = 0;
    this.budgetSkipped = 0;
    this.tickets = new Map();
    this.nextTicketId = 1;
    this.holdUntil = 0;
    this.lastNow = this.now();
    if (file) this.#load();
  }

  #load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad shape');
      if (!Array.isArray(raw.entries)) throw new Error('bad entries');
      this.entries = raw.entries
        .filter(row => row && FAMILIES.includes(row.family) && Number.isFinite(row.at))
        .map(row => ({
          at: finite(row.at),
          family: row.family,
          requests: Math.max(0, finite(row.requests)),
          weight: Math.max(0, finite(row.weight))
        }));
      this.enabledAt = finite(raw.enabledAt, this.enabledAt);
      this.physicalTotal = Math.max(0, finite(raw.physicalTotal));
      this.cacheHits = Math.max(0, finite(raw.cacheHits));
      this.budgetSkipped = Math.max(0, finite(raw.budgetSkipped));
      this.lastNow = Math.max(this.lastNow, ...this.entries.map(row => row.at), this.enabledAt);
    } catch {
      this.ledgerError = 'CORRUPT_LEDGER';
      this.entries = [];
      this.holdUntil = this.now() + this.windowMs;
    }
  }

  persist() {
    if (!this.file) return;
    this.#prune(this.now());
    atomicJson(this.file, {
      enabledAt: this.enabledAt,
      physicalTotal: this.physicalTotal,
      cacheHits: this.cacheHits,
      budgetSkipped: this.budgetSkipped,
      entries: this.entries.map(row => ({
        at: row.at,
        family: row.family,
        requests: row.requests,
        weight: row.weight
      }))
    });
  }

  #prune(at) {
    if (at < this.lastNow) {
      // Clock moved backwards: keep a conservative full-window history instead of wiping spend.
      const floor = this.lastNow - this.windowMs;
      this.entries = this.entries.filter(row => row.at >= floor);
    } else {
      const cutoff = at - this.windowMs;
      this.entries = this.entries.filter(row => row.at > cutoff);
    }
    this.lastNow = Math.max(this.lastNow, at);
  }

  #spentMap(at = this.now()) {
    this.#prune(at);
    const spent = emptySpent();
    for (const row of this.entries) {
      spent[row.family].requests += row.requests;
      spent[row.family].weight += row.weight;
    }
    return spent;
  }

  spent(family) {
    const row = this.#spentMap()[family] || { requests: 0, weight: 0 };
    return { requests: row.requests, weight: row.weight };
  }

  remaining(family) {
    if (family === 'AUTH') return { requests: Infinity, weight: Infinity };
    const limit = this.limits[family];
    if (!limit) return { requests: 0, weight: 0 };
    const spent = this.spent(family);
    const reserved = this.reserved[family] || { requests: 0, weight: 0 };
    return {
      requests: Math.max(0, limit.requests - spent.requests - reserved.requests),
      weight: Math.max(0, limit.weight - spent.weight - reserved.weight)
    };
  }

  canReserve(family, need) {
    if (this.now() < this.holdUntil) return false;
    if (family === 'AUTH') return true;
    const left = this.remaining(family);
    return left.requests >= need.requests && left.weight >= need.weight;
  }

  reserve(family, need = OBSERVE_RESERVE) {
    const requests = Math.max(0, Math.floor(finite(need.requests)));
    const weight = Math.max(0, finite(need.weight));
    if (!this.canReserve(family, { requests, weight })) {
      this.budgetSkipped += 1;
      throw Object.assign(new Error('SKIPPED_BUDGET'), { code: 'SKIPPED_BUDGET', family });
    }
    if (!this.reserved[family]) this.reserved[family] = { requests: 0, weight: 0 };
    this.reserved[family].requests += requests;
    this.reserved[family].weight += weight;
    const id = this.nextTicketId++;
    const ticket = {
      id,
      family,
      reservedRequests: requests,
      reservedWeight: weight,
      consumedRequests: 0,
      consumedWeight: 0,
      released: false
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  consume(ticket, { requests = 1, weight = 1, dispatched = true } = {}) {
    const live = this.tickets.get(ticket?.id);
    if (!live || live.released) return;
    const req = Math.max(0, Math.floor(finite(requests)));
    const w = Math.max(0, finite(weight));
    live.consumedRequests += req;
    live.consumedWeight += w;
    if (dispatched && req > 0) {
      this.#charge(live.family, req, w);
    }
  }

  noteCacheHit(ticket) {
    this.cacheHits += 1;
    void ticket;
  }

  release(ticket) {
    const live = this.tickets.get(ticket?.id);
    if (!live || live.released) return;
    live.released = true;
    const unusedReq = Math.max(0, live.reservedRequests - live.consumedRequests);
    const unusedWeight = Math.max(0, live.reservedWeight - live.consumedWeight);
    if (this.reserved[live.family]) {
      this.reserved[live.family].requests = Math.max(0, this.reserved[live.family].requests - live.reservedRequests);
      this.reserved[live.family].weight = Math.max(0, this.reserved[live.family].weight - live.reservedWeight);
    }
    // Unused reservation is simply freed; consumed portion stays in the rolling ledger.
    void unusedReq;
    void unusedWeight;
    this.tickets.delete(live.id);
  }

  recordPhysical({ family = 'AUTH', requests = 1, weight = 1 } = {}) {
    this.#charge(family, requests, weight);
  }

  #charge(family, requests, weight) {
    const at = this.now();
    this.#prune(at);
    this.entries.push({
      at,
      family: FAMILIES.includes(family) ? family : 'AUTH',
      requests: Math.max(0, Math.floor(finite(requests))),
      weight: Math.max(0, finite(weight))
    });
    this.physicalTotal += Math.max(0, Math.floor(finite(requests)));
  }

  metrics() {
    const spent = this.#spentMap();
    return {
      windowMs: this.windowMs,
      physicalRequests: this.physicalTotal,
      cacheHits: this.cacheHits,
      budgetSkipped: this.budgetSkipped,
      ledgerError: this.ledgerError || '',
      holdUntil: this.holdUntil,
      spent,
      remaining: Object.fromEntries(
        ['AUDIT', 'DISCOVERY', 'OUTCOME', 'LIVE'].map(name => [name, this.remaining(name)])
      ),
      reserved: structuredClone(this.reserved)
    };
  }

  snapshot() {
    return this.metrics();
  }
}
