import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { atomicJson, readJsonWithBackup, tokenKey } from './local-store.mjs';
import { nansenEvidence } from './nansen.mjs';
import { migrateWatchEntry } from './audit-scheduler.mjs';

const RETENTION_MS = 7 * 86400_000;
const OUTCOMES = ['', 'USER_REPORTED_RUG', 'USER_REPORTED_GRADUATED'];
const valid = (chain, address) => config.supportedChains.includes(chain) && typeof address === 'string'
  && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(address);
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clean = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, limit) : '';
const reasons = values => Array.isArray(values) ? values.filter(x => typeof x === 'string').slice(0, 30).map(x => clean(x)) : [];

function chartRiskEvidence(source) {
  if (!source || typeof source !== 'object') return null;
  const version = finite(source.version);
  const status = clean(source.status, 32);
  if (!version && !status) return null;
  return {
    version: version || 0,
    status: status || 'UNKNOWN',
    pass: source.pass === true,
    from: finite(source.from) || 0,
    to: finite(source.to) || 0,
    codes: Array.isArray(source.codes) ? source.codes.slice(0, 5).map(c => clean(c, 32)) : [],
    reasons: Array.isArray(source.reasons) ? source.reasons.slice(0, 5).map(r => clean(r, 100)) : []
  };
}

function observationFields(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    source: clean(source.source, 40) || 'GMGN_INFO',
    observedAt: finite(source.observedAt) || finite(source.collectedAt) || 0,
    collectedAt: finite(source.collectedAt) || finite(source.observedAt) || 0,
    price: finite(source.price),
    marketCap: finite(source.marketCap),
    liquidity: finite(source.liquidity),
    poolId: source.poolId == null ? null : clean(String(source.poolId), 120),
    status: source.status == null ? null : clean(String(source.status), 80),
    changeDetected: source.changeDetected === true
  };
}

export class WatchPool {
  constructor(dir, { now = Date.now, maxEntries = 500, windowMs = config.scanIntervalMs } = {}) {
    this.file = path.join(dir, 'watch-pool.json');
    this.now = now;
    this.windowMs = Math.max(1, Number(windowMs) || config.scanIntervalMs || 120_000);
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, 500) : 500;
    this.supplementDropped = 0;
    const { value } = readJsonWithBackup(this.file, { entries: [] });
    if (!Array.isArray(value.entries)) throw fail('invalid_watch_pool_state');
    const at = this.now();
    this.entries = new Map(value.entries.filter(x => x && valid(x.chain, x.address)).map(x => {
      const migrated = migrateWatchEntry(x, { now: at, windowMs: this.windowMs });
      return [tokenKey(migrated.chain, migrated.address), migrated];
    }));
  }
  save() { atomicJson(this.file, { entries: [...this.entries.values()] }); }
  prune(at) {
    for (const [key, item] of this.entries) {
      if (item.source !== 'manual' && !item.pinned && !item.riskLatched && at - item.lastSeenAt > RETENTION_MS) this.entries.delete(key);
    }
  }
  makeRoom(protectedKeys = new Set(), at = this.now()) {
    if (this.entries.size < this.maxEntries) return true;
    const oldest = [...this.entries.entries()].filter(([key, x]) => !x.pinned && !x.riskLatched && x.source !== 'manual' && !protectedKeys.has(key)
      && !(x.checkCount < 3 && at - x.firstSeenAt < 86400_000))
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt || a[1].firstSeenAt - b[1].firstSeenAt)[0];
    if (!oldest) return false;
    this.entries.delete(oldest[0]);
    return true;
  }
  create(chain, address, at) {
    return migrateWatchEntry({
      chain, address: chain === 'sol' ? address : address.toLowerCase(), symbol: '', label: '', source: 'discovery',
      pinned: false, reportedOutcome: '', firstSeenAt: at, lastSeenAt: at, nextCheckAt: at,
      checkCount: 0, paused: false, riskLatched: false, latest: null, history: [],
      lastObservation: null, observationHistory: [], observationCount: 0, nextObservationAt: at,
      modeCursor: 'OBSERVE', lastObservationError: null
    }, { now: at, windowMs: this.windowMs });
  }
  add({ chain, address, label = '', reportedOutcome = '' }) {
    if (!valid(chain, address) || typeof label !== 'string' || label.length > 80 || !OUTCOMES.includes(reportedOutcome)) throw fail('invalid_watch_entry');
    const at = this.now();
    this.prune(at);
    const key = tokenKey(chain, address);
    if (!this.entries.has(key) && !this.makeRoom(new Set(), at)) throw fail('watch_pool_limit');
    const item = this.entries.get(key) || this.create(chain, address, at);
    Object.assign(item, {
      source: 'manual', pinned: true, label: clean(label, 80), reportedOutcome, lastSeenAt: at,
      modeCursor: 'DEEP', forceDeepReview: true
    });
    this.entries.set(key, item);
    this.save();
    return this.snapshot(chain).find(x => x.address === item.address);
  }
  capture(chain, screened, at = this.now()) {
    this.prune(at);
    const rows = Array.isArray(screened) ? screened.filter(x => x?.row && valid(chain, x.row.address)) : [];
    // 同批已有条目优先保护，新纳入条目也不得被后续条目反复替换。
    const protectedKeys = new Set(rows.map(x => tokenKey(chain, x.row.address)).filter(key => this.entries.has(key)));
    for (const { row, screen } of rows) {
      const key = tokenKey(chain, row.address);
      if (!this.entries.has(key) && !this.makeRoom(protectedKeys, at)) continue;
      const item = this.entries.get(key) || this.create(chain, row.address, at);
      item.lastSeenAt = at;
      item.symbol = clean(row.symbol, 80) || item.symbol;
      if (item.checkCount === 0) item.latest = { at, status: screen?.pass ? 'DISCOVERY_PASS' : 'DISCOVERY_REJECTED', reasons: reasons(screen?.reasons),
        price: finite(row.price), marketCap: finite(screen?.mc), liquidity: finite(screen?.liquidity), error: '' };
      this.entries.set(key, item);
      protectedKeys.add(key);
    }
    this.save();
    return this.snapshot(chain);
  }
  snapshot(chain) {
    return [...this.entries.values()].filter(x => !chain || x.chain === chain).map(x => structuredClone({
      chain: x.chain, address: x.address, symbol: x.symbol, label: x.label, source: x.source,
      reportedOutcome: x.reportedOutcome, firstSeenAt: x.firstSeenAt, lastSeenAt: x.lastSeenAt,
      nextCheckAt: x.nextCheckAt, checkCount: x.checkCount, paused: x.paused, riskLatched: x.riskLatched,
      latest: x.latest, history: x.history,
      lastObservation: x.lastObservation || null,
      observationHistory: x.observationHistory || [],
      observationCount: x.observationCount || 0,
      nextObservationAt: x.nextObservationAt,
      modeCursor: x.modeCursor || 'OBSERVE',
      lastObservationError: x.lastObservationError || null,
      forceDeepReview: x.forceDeepReview === true
    }));
  }
  due(chain, at = this.now(), limit = 1) {
    return this.snapshot(chain).filter(x => !x.paused && x.nextCheckAt <= at)
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt || a.firstSeenAt - b.firstSeenAt || a.address.localeCompare(b.address))
      .slice(0, Number.isInteger(limit) && limit > 0 ? limit : 0);
  }
  dueObservations(chain, at = this.now(), limit = 1) {
    return this.snapshot(chain).filter(x => !x.paused && Number(x.nextObservationAt || 0) <= at)
      .sort((a, b) => a.nextObservationAt - b.nextObservationAt || a.firstSeenAt - b.firstSeenAt || a.address.localeCompare(b.address))
      .slice(0, Number.isInteger(limit) && limit > 0 ? limit : 0);
  }
  setPaused({ chain, address, paused }) {
    if (!valid(chain, address) || typeof paused !== 'boolean') throw fail('invalid_watch_entry');
    const item = this.entries.get(tokenKey(chain, address));
    if (!item) throw Object.assign(new Error('watch_entry_not_found'), { statusCode: 404 });
    item.paused = paused;
    this.save();
    return this.snapshot(chain).find(x => x.address === item.address);
  }
  record(candidate, at = this.now()) {
    if (!candidate || !valid(candidate.chain, candidate.address)) throw fail('invalid_watch_entry');
    const item = this.entries.get(tokenKey(candidate.chain, candidate.address));
    if (!item || item.paused) return null;
    const error = clean(candidate.auditError, 500);
    const reviewId = clean(candidate.reviewId, 80) || crypto.randomBytes(8).toString('hex');
    const result = { at, reviewId, status: clean(candidate.status, 80) || 'WAIT_RECHECK',
      reasons: [...reasons(candidate.deep?.failed), ...reasons([candidate.decisionReason])],
      price: finite(candidate.price), marketCap: finite(candidate.marketCap), liquidity: finite(candidate.liquidity),
      chartRisk: chartRiskEvidence(candidate.deep?.chartRisk || candidate.chartRisk),
      nansen: nansenEvidence(candidate.nansen), error };
    // 风险锁只增不减，后续恢复读数保留在历史中，不覆盖既有风险。
    item.riskLatched ||= candidate.deep?.security?.honeypot === true || candidate.secondary?.security?.verdict === 'FATAL';
    item.checkCount += 1;
    const delay = item.riskLatched || candidate.status === 'HARD_REJECT' ? 3600_000 : item.checkCount === 1 ? 120_000 : item.checkCount === 2 ? 300_000 : 900_000;
    item.nextCheckAt = at + delay;
    item.latest = result;
    item.history = [...item.history, result].slice(-20);
    // Fresh deep info may refresh market fields without inventing an observation request.
    if (finite(candidate.price) != null || finite(candidate.marketCap) != null || finite(candidate.liquidity) != null) {
      const observation = observationFields({
        source: 'GMGN_DEEP_INFO',
        observedAt: at,
        collectedAt: at,
        price: candidate.price,
        marketCap: candidate.marketCap,
        liquidity: candidate.liquidity,
        poolId: candidate.poolId,
        status: candidate.poolStatus
      });
      if (observation) {
        item.lastObservation = observation;
        item.observationHistory = [...(item.observationHistory || []), observation].slice(-20);
      }
    }
    this.save();
    return this.snapshot(candidate.chain).find(x => x.address === item.address);
  }

  recordObservation({ chain, address, observation, nextObservationAt }) {
    if (!valid(chain, address)) throw fail('invalid_watch_entry');
    const item = this.entries.get(tokenKey(chain, address));
    if (!item || item.paused) return null;
    const row = observationFields(observation);
    if (!row) throw fail('invalid_observation');
    const prev = item.lastObservation;
    row.changeDetected = Boolean(prev && (
      (finite(prev.price) != null && finite(row.price) != null && prev.price !== row.price)
      || (finite(prev.liquidity) != null && finite(row.liquidity) != null && prev.liquidity !== row.liquidity)
    ));
    item.lastObservation = row;
    item.observationHistory = [...(item.observationHistory || []), row].slice(-20);
    item.observationCount = finite(item.observationCount) + 1;
    item.nextObservationAt = finite(nextObservationAt) ?? (row.observedAt + 120_000);
    item.lastObservationError = null;
    // OBSERVE must not mutate deep safety clocks or risk latch.
    this.save();
    return this.snapshot(chain).find(x => x.address === item.address);
  }

  recordObservationFailure({ chain, address, error, at = this.now(), nextObservationAt }) {
    if (!valid(chain, address)) throw fail('invalid_watch_entry');
    const item = this.entries.get(tokenKey(chain, address));
    if (!item || item.paused) return null;
    item.lastObservationError = {
      at: finite(at) || this.now(),
      code: clean(error, 80) || 'OBSERVE_FAILED'
    };
    item.nextObservationAt = finite(nextObservationAt) ?? (item.lastObservationError.at + 60_000);
    this.save();
    return this.snapshot(chain).find(x => x.address === item.address);
  }

  attachSupplement({ chain, address, reviewId, supplement }) {
    if (!valid(chain, address) || typeof reviewId !== 'string' || !reviewId) {
      this.supplementDropped += 1;
      return { attached: false, reason: 'invalid' };
    }
    const item = this.entries.get(tokenKey(chain, address));
    if (!item) {
      this.supplementDropped += 1;
      return { attached: false, reason: 'missing' };
    }
    const evidence = nansenEvidence(supplement);
    if (!evidence) {
      this.supplementDropped += 1;
      return { attached: false, reason: 'invalid_supplement' };
    }
    const historyIndex = (item.history || []).findIndex(row => row?.reviewId === reviewId);
    if (historyIndex < 0) {
      this.supplementDropped += 1;
      return { attached: false, reason: 'review_not_found' };
    }
    item.history[historyIndex] = { ...item.history[historyIndex], nansen: evidence };
    if (item.latest?.reviewId === reviewId) {
      item.latest = { ...item.latest, nansen: evidence };
    }
    this.save();
    return { attached: true };
  }
}
