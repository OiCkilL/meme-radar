import path from 'node:path';
import { config } from './config.mjs';
import { atomicJson, readJsonWithBackup, tokenKey } from './local-store.mjs';

const RETENTION_MS = 7 * 86400_000;
const OUTCOMES = ['', 'USER_REPORTED_RUG', 'USER_REPORTED_GRADUATED'];
const valid = (chain, address) => config.supportedChains.includes(chain) && typeof address === 'string'
  && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(address);
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clean = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, limit) : '';
const reasons = values => Array.isArray(values) ? values.filter(x => typeof x === 'string').slice(0, 30).map(x => clean(x)) : [];

export class WatchPool {
  constructor(dir, { now = Date.now, maxEntries = 500 } = {}) {
    this.file = path.join(dir, 'watch-pool.json');
    this.now = now;
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, 500) : 500;
    const { value } = readJsonWithBackup(this.file, { entries: [] });
    if (!Array.isArray(value.entries)) throw fail('invalid_watch_pool_state');
    this.entries = new Map(value.entries.filter(x => x && valid(x.chain, x.address)).map(x => [tokenKey(x.chain, x.address), x]));
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
    return { chain, address: chain === 'sol' ? address : address.toLowerCase(), symbol: '', label: '', source: 'discovery',
      pinned: false, reportedOutcome: '', firstSeenAt: at, lastSeenAt: at, nextCheckAt: at,
      checkCount: 0, paused: false, riskLatched: false, latest: null, history: [] };
  }
  add({ chain, address, label = '', reportedOutcome = '' }) {
    if (!valid(chain, address) || typeof label !== 'string' || label.length > 80 || !OUTCOMES.includes(reportedOutcome)) throw fail('invalid_watch_entry');
    const at = this.now();
    this.prune(at);
    const key = tokenKey(chain, address);
    if (!this.entries.has(key) && !this.makeRoom(new Set(), at)) throw fail('watch_pool_limit');
    const item = this.entries.get(key) || this.create(chain, address, at);
    Object.assign(item, { source: 'manual', pinned: true, label: clean(label, 80), reportedOutcome, lastSeenAt: at });
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
      latest: x.latest, history: x.history
    }));
  }
  due(chain, at = this.now(), limit = 1) {
    return this.snapshot(chain).filter(x => !x.paused && x.nextCheckAt <= at)
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt || a.firstSeenAt - b.firstSeenAt || a.address.localeCompare(b.address))
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
    const result = { at, status: clean(candidate.status, 80) || 'WAIT_RECHECK',
      reasons: [...reasons(candidate.deep?.failed), ...reasons([candidate.decisionReason])],
      price: finite(candidate.price), marketCap: finite(candidate.marketCap), liquidity: finite(candidate.liquidity), error };
    // 风险锁只增不减，后续恢复读数保留在历史中，不覆盖既有风险。
    item.riskLatched ||= candidate.deep?.security?.honeypot === true || candidate.secondary?.security?.verdict === 'FATAL';
    item.checkCount += 1;
    const delay = item.riskLatched || candidate.status === 'HARD_REJECT' ? 3600_000 : item.checkCount === 1 ? 120_000 : item.checkCount === 2 ? 300_000 : 900_000;
    item.nextCheckAt = at + delay;
    item.latest = result;
    item.history = [...item.history, result].slice(-20);
    this.save();
    return this.snapshot(candidate.chain).find(x => x.address === item.address);
  }
}
