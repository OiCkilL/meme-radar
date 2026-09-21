import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJsonWithBackup } from './local-store.mjs';
import { nansenEvidence } from './nansen.mjs';

function cleanCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const { rawDiscovery: _rawDiscovery, ...clean } = candidate;
  return clean;
}

function addressKey(value) {
  const address = String(value ?? '').trim();
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address;
}

function defaultState() {
  return {
    version: 2,
    revision: 0,
    status: 'STARTING',
    generatedAt: 0,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    nextCycleAt: 0,
    cycleStartedAt: 0,
    scanInProgress: false,
    activeChain: 'robinhood',
    pendingChain: '',
    supportedChains: ['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable'],
    chainStates: {},
    riskExclusions: {},
    scanCount: 0,
    discoveredCount: 0,
    prequalifiedCount: 0,
    candidates: [],
    rejected: [],
    auditQueue: [],
    auditQueueStats: { total: 0, due: 0, neverAudited: 0, waitingRecheck: 0 },
    outcomes: [],
    outcomeSummary: {
      minimumSample: 50, calibrationReady: false,
      tracked: 0, completed5m: 0, completed15m: 0, completed30m: 0,
      completed1h: 0, completed2h: 0, completed6h: 0, completed24h: 0
    },
    sourceHealth: {},
    events: [],
    pendingProjection: null,
    throughput: { budgetSkipped: 0, deepComplete: 0, observationComplete: 0 }
  };
}

function migrateState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    version: 2,
    revision: Number.isFinite(raw.revision) ? raw.revision : 0,
    scanInProgress: false,
    candidates: Array.isArray(raw.candidates) ? raw.candidates.map(cleanCandidate) : [],
    rejected: Array.isArray(raw.rejected) ? raw.rejected : [],
    auditQueue: Array.isArray(raw.auditQueue) ? raw.auditQueue : [],
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    riskExclusions: raw.riskExclusions && typeof raw.riskExclusions === 'object' && !Array.isArray(raw.riskExclusions)
      ? raw.riskExclusions : {},
    throughput: raw.throughput && typeof raw.throughput === 'object' ? raw.throughput : base.throughput
  };
}

export class RadarState {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'radar.json');
    this.value = this.load();
    this.gmgnKeyEpoch = 0;
  }

  load() {
    const loaded = readJsonWithBackup(this.file, defaultState());
    const value = migrateState(loaded.value);
    if (loaded.recovered) value.events.unshift({ at: Date.now(), type: 'STATE_RECOVERED', message: '主状态文件异常，已从本机备份恢复' });
    return value;
  }

  save(next = this.value) {
    this.value = next;
    atomicJson(this.file, next);
  }

  event(type, message, data = {}) {
    const events = this.value.events || [];
    events.unshift({ at: Date.now(), type, message, ...data });
    this.value.events = events.slice(0, 500);
  }

  commitCandidate({ chain, address, reviewId, keyEpoch, candidate }) {
    if (keyEpoch != null && keyEpoch !== this.gmgnKeyEpoch) {
      return { committed: false, reason: 'key_epoch' };
    }
    if (!candidate || !chain || !address || !reviewId) {
      return { committed: false, reason: 'invalid' };
    }
    try {
      const current = this.value;
      const active = current.activeChain === chain;
      const scope = active ? current : (current.chainStates?.[chain] || {});
      const list = Array.isArray(scope.candidates) ? [...scope.candidates] : [];
      const key = addressKey(address);
      const index = list.findIndex(row => addressKey(row.address) === key);
      const nextCandidate = cleanCandidate({ ...candidate, chain, address, reviewId });
      if (index >= 0) list[index] = nextCandidate;
      else list.unshift(nextCandidate);
      const revision = Number(current.revision || 0) + 1;
      if (active) {
        this.save({
          ...current,
          revision,
          candidates: list.slice(0, 200),
          generatedAt: Date.now()
        });
      } else {
        const chainStates = { ...(current.chainStates || {}) };
        chainStates[chain] = { ...scope, candidates: list.slice(0, 200) };
        this.save({ ...current, revision, chainStates, generatedAt: Date.now() });
      }
      return { committed: true, revision };
    } catch (error) {
      this.value.pendingProjection = {
        at: Date.now(),
        type: 'commitCandidate',
        chain,
        address: addressKey(address),
        reviewId,
        error: String(error?.code || 'STATE_WRITE_FAILED')
      };
      return { committed: false, reason: 'write_failed' };
    }
  }

  attachSupplement({ chain, address, reviewId, keyEpoch, supplement }) {
    if (keyEpoch != null && keyEpoch !== this.gmgnKeyEpoch) {
      return { attached: false, reason: 'key_epoch' };
    }
    const evidence = nansenEvidence(supplement);
    if (!evidence || !reviewId) return { attached: false, reason: 'invalid' };
    try {
      const current = this.value;
      const active = current.activeChain === chain;
      const scope = active ? current : (current.chainStates?.[chain] || {});
      const list = Array.isArray(scope.candidates) ? [...scope.candidates] : [];
      const key = addressKey(address);
      const index = list.findIndex(row => addressKey(row.address) === key && row.reviewId === reviewId);
      if (index < 0) return { attached: false, reason: 'review_not_found' };
      list[index] = { ...list[index], nansen: evidence };
      const revision = Number(current.revision || 0) + 1;
      if (active) this.save({ ...current, revision, candidates: list, generatedAt: Date.now() });
      else {
        const chainStates = { ...(current.chainStates || {}) };
        chainStates[chain] = { ...scope, candidates: list };
        this.save({ ...current, revision, chainStates, generatedAt: Date.now() });
      }
      return { attached: true, revision };
    } catch (error) {
      this.value.pendingProjection = {
        at: Date.now(),
        type: 'attachSupplement',
        chain,
        address: addressKey(address),
        reviewId,
        error: String(error?.code || 'STATE_WRITE_FAILED')
      };
      return { attached: false, reason: 'write_failed' };
    }
  }
}
