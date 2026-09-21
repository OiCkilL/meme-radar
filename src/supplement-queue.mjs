import { tokenKey } from './local-store.mjs';
import { nansenEvidence } from './nansen.mjs';

const MAX_QUEUE = 12;
const TTL_MS = 10 * 60_000;

export class SupplementQueue {
  constructor({
    nansen = null,
    watchPool = null,
    state = null,
    now = Date.now,
    windowMs = 120_000,
    maxConcurrent = 1,
    maxPerWindow = 1
  } = {}) {
    this.nansen = nansen;
    this.watchPool = watchPool;
    this.state = state;
    this.now = now;
    this.windowMs = windowMs;
    this.maxConcurrent = maxConcurrent;
    this.maxPerWindow = maxPerWindow;
    this.pending = [];
    this.active = 0;
    this.recentStarts = [];
    this.dropped = 0;
    this.manualCursor = 0;
    this.timer = null;
    this.disposed = false;
    this.observed = new Set();
  }

  enqueue(job) {
    if (this.disposed || !job) return { queued: false, reason: 'disposed' };
    const key = `${job.tokenKey || tokenKey(job.chain, job.address)}:${job.reviewId}`;
    this.pending = this.pending.filter(row => !(row.tokenKey === (job.tokenKey || tokenKey(job.chain, job.address)) && row.reviewId !== job.reviewId));
    if (this.pending.some(row => `${row.tokenKey}:${row.reviewId}` === key)) return { queued: true, reason: 'duplicate' };
    if (this.pending.length >= MAX_QUEUE) {
      this.dropped += 1;
      return { queued: false, reason: 'full' };
    }
    this.pending.push({
      ...job,
      tokenKey: job.tokenKey || tokenKey(job.chain, job.address),
      enqueuedAt: this.now(),
      expiresAt: this.now() + TTL_MS,
      manual: job.manual === true
    });
    this.#pump();
    return { queued: true };
  }

  #prune() {
    const at = this.now();
    const before = this.pending.length;
    this.pending = this.pending.filter(row => row.expiresAt > at);
    this.dropped += before - this.pending.length;
    this.recentStarts = this.recentStarts.filter(ts => at - ts < this.windowMs);
  }

  #pump() {
    if (this.disposed) return;
    this.#prune();
    while (this.active < this.maxConcurrent && this.pending.length && this.recentStarts.length < this.maxPerWindow) {
      const manualWanted = this.manualCursor % 2 === 0;
      let index = this.pending.findIndex(row => Boolean(row.manual) === manualWanted);
      if (index < 0) index = 0;
      const job = this.pending.splice(index, 1)[0];
      this.manualCursor += 1;
      this.active += 1;
      this.recentStarts.push(this.now());
      const task = this.#run(job).finally(() => {
        this.active -= 1;
        this.observed.delete(task);
        this.#pump();
      });
      this.observed.add(task);
      void task.catch(() => {});
    }
  }

  async #run(job) {
    if (this.disposed) return;
    if (!this.nansen?.snapshot?.().enabled) return;
    if (job.keyEpoch != null && this.state?.gmgnKeyEpoch != null && job.keyEpoch !== this.state.gmgnKeyEpoch) return;
    const deadline = Math.min(job.deadline || Infinity, this.now() + 5_000);
    let result;
    try {
      result = await this.nansen.review({
        chain: job.chain,
        address: job.address,
        deadline
      });
    } catch {
      return;
    }
    if (this.disposed) return;
    if (!result || ['SKIPPED_BUDGET', 'TIME_BUDGET', 'ERROR', 'RATE_LIMITED', 'CANCELLED', 'DISABLED', 'UNCONFIGURED'].includes(result.status)) {
      return;
    }
    const evidence = nansenEvidence(result);
    if (!evidence) return;
    this.watchPool?.attachSupplement?.({
      chain: job.chain,
      address: job.address,
      reviewId: job.reviewId,
      supplement: evidence
    });
    this.state?.attachSupplement?.({
      chain: job.chain,
      address: job.address,
      reviewId: job.reviewId,
      keyEpoch: job.keyEpoch,
      supplement: evidence
    });
  }

  async flush(timeoutMs = 1_000) {
    const started = this.now();
    while ((this.active > 0 || this.pending.length > 0) && this.now() - started < timeoutMs) {
      this.#pump();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  dispose() {
    this.disposed = true;
    this.pending = [];
    if (this.timer) clearTimeout(this.timer);
  }
}
