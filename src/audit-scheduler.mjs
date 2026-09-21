import { tokenKey } from './local-store.mjs';

const LANES = Object.freeze(['MANUAL', 'DISCOVERY', 'RECHECK', 'RISK']);
const SOFT_HARD_REASONS = new Set(['liquidity', 'concentration', 'observation', 'marketBehavior', 'wallets']);

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function hashSpread(key, modulo) {
  const text = String(key || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const mod = Math.max(1, Math.floor(modulo) || 1);
  return (hash >>> 0) % mod;
}

export function classifyLane(row = {}) {
  if (row.riskLatched) return 'RISK';
  if (row.source === 'manual' || row.favorite === true || row.pinned === true) return 'MANUAL';
  if (row.source === 'discovery' && finite(row.checkCount) === 0
    && !['DISCOVERY_REJECTED', 'WAIT_RECHECK', 'HARD_REJECT', 'X_REVIEW'].includes(row.status)) {
    return 'DISCOVERY';
  }
  if (row.source === 'discovery' && finite(row.checkCount) === 0 && row.status === 'DISCOVERY_PASS') {
    return 'DISCOVERY';
  }
  if (row.firstAudit === true || (finite(row.checkCount) === 0 && row.status !== 'DISCOVERY_REJECTED' && !row.delisted)) {
    if (row.source === 'discovery' || row.laneHint === 'DISCOVERY') return 'DISCOVERY';
  }
  return 'RECHECK';
}

export function classifyModeEligibility(row = {}) {
  const hardFailed = Array.isArray(row.hardFailed) ? row.hardFailed : [];
  const forcedDeep = Boolean(
    row.forceDeepReview
    || row.source === 'manual'
    || row.favorite === true
    || row.riskLatched
    || row.status === 'X_REVIEW'
  );
  if (forcedDeep) {
    return { forcedDeep: true, allowObserve: true, reason: 'forced_deep_category' };
  }

  if (row.status === 'HARD_REJECT' && !row.riskLatched) {
    const softOnly = hardFailed.length > 0 && hardFailed.every(name => SOFT_HARD_REASONS.has(name));
    if (!softOnly) {
      return { forcedDeep: true, allowObserve: false, reason: 'unclear_hard_reject' };
    }
    return { forcedDeep: false, allowObserve: true, reason: 'soft_hard_reject' };
  }

  if (row.status === 'DISCOVERY_REJECTED' || row.delisted || row.status === 'WAIT_RECHECK'
    || row.allowObserve === true) {
    return { forcedDeep: false, allowObserve: true, reason: 'ordinary_observe' };
  }

  if (finite(row.checkCount) === 0 && row.status !== 'DISCOVERY_REJECTED') {
    return { forcedDeep: true, allowObserve: false, reason: 'first_discovery_deep' };
  }

  return { forcedDeep: false, allowObserve: true, reason: 'default_observe' };
}

export function advanceModeCursor(current, dispatchedMode) {
  if (dispatchedMode === 'OBSERVE') return 'DEEP';
  if (dispatchedMode === 'DEEP') return 'OBSERVE';
  return current === 'DEEP' ? 'OBSERVE' : 'DEEP';
}

export function migrateWatchEntry(entry, { now = Date.now(), windowMs = 120_000 } = {}) {
  const key = tokenKey(entry.chain, entry.address);
  const eligibility = classifyModeEligibility({
    ...entry,
    status: entry.status || entry.latest?.status,
    hardFailed: entry.hardFailed || entry.latest?.reasons || []
  });
  const next = { ...entry };
  if (!Number.isFinite(next.nextObservationAt)) {
    next.nextObservationAt = now + hashSpread(key, Math.max(1, windowMs));
  }
  if (!next.modeCursor) {
    next.modeCursor = eligibility.forcedDeep ? 'DEEP' : 'OBSERVE';
  }
  if (!Array.isArray(next.observationHistory)) next.observationHistory = [];
  if (!Number.isFinite(next.observationCount)) next.observationCount = 0;
  if (next.lastObservation === undefined) next.lastObservation = null;
  return next;
}

function laneSort(a, b) {
  return finite(a.dueAt) - finite(b.dueAt)
    || finite(a.firstSeenAt) - finite(b.firstSeenAt)
    || String(a.key).localeCompare(String(b.key));
}

function resolveMode(item, { deepBudgetLeft, observeBudgetLeft, deepProtect, deepSelected }) {
  const eligibility = {
    forcedDeep: item.forcedDeep === true,
    allowObserve: item.allowObserve !== false
  };
  if (item.paused || item.blocked) return null;

  const deepDue = Number.isFinite(item.deepDueAt) ? item.deepDueAt <= item.dueAt || item.deepDueAt <= (item.now || item.dueAt)
    : item.mode === 'DEEP' || eligibility.forcedDeep;
  const observeDue = Number.isFinite(item.observeDueAt)
    ? item.observeDueAt <= (item.now || item.dueAt)
    : item.mode === 'OBSERVE' || eligibility.allowObserve;

  const prefer = item.modeCursor || item.mode || (eligibility.forcedDeep ? 'DEEP' : 'OBSERVE');

  if (eligibility.forcedDeep && deepDue) {
    if (deepBudgetLeft > 0) return 'DEEP';
    return null;
  }

  if (prefer === 'OBSERVE' && eligibility.allowObserve && observeDue && observeBudgetLeft > 0) {
    // Keep deep protect envelope: do not spend the last deep slots on observe when deep work remains.
    if (deepProtect > deepSelected && item.deepDueAt != null && item.deepDueAt <= (item.now || item.dueAt) && deepBudgetLeft > 0) {
      return 'DEEP';
    }
    return 'OBSERVE';
  }

  if (deepDue && deepBudgetLeft > 0) return 'DEEP';
  if (eligibility.allowObserve && observeDue && observeBudgetLeft > 0) return 'OBSERVE';
  return null;
}

export function selectFairTasks(items, {
  now = Date.now(),
  limit = 1,
  deepProtect = 0,
  deepBudgetLeft = 0,
  observeBudgetLeft = 0,
  cursor = { lane: 0, mode: {} }
} = {}) {
  const pools = Object.fromEntries(LANES.map(name => [name, []]));
  for (const raw of items || []) {
    if (!raw || raw.paused) continue;
    const lane = LANES.includes(raw.lane) ? raw.lane : classifyLane(raw);
    const dueAt = finite(raw.dueAt, Infinity);
    if (dueAt > now) continue;
    if (raw.nextEligibleAt && finite(raw.nextEligibleAt) > now) continue;
    pools[lane].push({
      ...raw,
      lane,
      key: raw.key || tokenKey(raw.chain, raw.address),
      dueAt,
      firstSeenAt: finite(raw.firstSeenAt),
      now
    });
  }
  for (const lane of LANES) pools[lane].sort(laneSort);

  const selected = [];
  const usedKeys = new Set();
  let laneCursor = Number.isInteger(cursor.lane) ? cursor.lane % LANES.length : 0;
  let deepSelected = 0;
  let deepLeft = deepBudgetLeft;
  let observeLeft = observeBudgetLeft;
  const modeCursor = { ...(cursor.mode || {}) };

  while (selected.length < limit) {
    let picked = null;
    let pickedLaneIndex = -1;
    for (let offset = 0; offset < LANES.length; offset++) {
      const index = (laneCursor + offset) % LANES.length;
      const lane = LANES[index];
      const queue = pools[lane];
      while (queue.length && usedKeys.has(queue[0].key)) queue.shift();
      if (!queue.length) continue;
      const candidate = queue[0];
      const mode = resolveMode(candidate, {
        deepBudgetLeft: deepLeft,
        observeBudgetLeft: observeLeft,
        deepProtect,
        deepSelected
      });
      if (!mode) {
        queue.shift();
        continue;
      }
      picked = { ...candidate, mode };
      pickedLaneIndex = index;
      break;
    }
    if (!picked) break;
    pools[picked.lane].shift();
    usedKeys.add(picked.key);
    selected.push(picked);
    if (picked.mode === 'DEEP') {
      deepSelected += 1;
      deepLeft = Math.max(0, deepLeft - 1);
    } else {
      observeLeft = Math.max(0, observeLeft - 1);
    }
    laneCursor = (pickedLaneIndex + 1) % LANES.length;
  }

  return {
    selected,
    cursor: { lane: laneCursor, mode: modeCursor }
  };
}

export const SCHEDULER_LANES = LANES;
