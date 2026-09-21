import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CHAINS = { sol: 'solana', bsc: 'bnb', base: 'base', eth: 'ethereum', robinhood: 'robinhood' };
const STATUSES = new Set(['DISABLED', 'UNCONFIGURED', 'UNSUPPORTED', 'TIME_BUDGET', 'OK', 'EMPTY', 'ERROR', 'RATE_LIMITED', 'CANCELLED']);
export const NANSEN_MIN_INTERVAL_MS = 5 * 60_000;
export const NANSEN_CACHE_TTL_MS = 30 * 60_000;
const ERRORS = new Set(['INVALID_ADDRESS', 'HTTP_ERROR', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'TIMEOUT', 'RATE_LIMITED', 'CONFIG_CHANGED']);
const validKey = key => typeof key === 'string' && /^[\x21-\x7e]{8,512}$/.test(key);
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
const label = (value, secret = '') => typeof value === 'string' && !/sk[-_]|api[_-]?key|bearer\s|[A-Za-z0-9_-]{32,}/i.test(value) && !(secret && value.includes(secret)) ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : null;
const holderAddress = value => typeof value === 'string' && (/^0x[0-9a-f]{40}$/i.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value));

export function nansenEvidence(value) {
  if (!value || !STATUSES.has(value.status) || (value.errorCode != null && !ERRORS.has(value.errorCode))) return null;
  const holders = Array.isArray(value.holders) ? value.holders.slice(0, 20).filter(row => row && holderAddress(row.address)).map(row => ({
    address: row.address, label: label(row.label), tokenAmount: number(row.tokenAmount), ownershipPercentage: number(row.ownershipPercentage), balanceChange24h: number(row.balanceChange24h), valueUsd: number(row.valueUsd)
  })) : [];
  return { source: 'NANSEN', status: value.status, checkedAt: number(value.checkedAt), errorCode: value.errorCode ?? null, sampled: true, sampleCount: holders.length, hasMore: value.hasMore === true, holders };
}

export class NansenIntegration {
  #apiKey = ''; #configurationError = ''; #enabled = false; #revision = 0; #requests = new Set();
  #cooldownUntil = 0; #cooldownResult = ['RATE_LIMITED', 'RATE_LIMITED'];
  #cache = new Map(); #nextHttpAt = 0;
  constructor(dir, {
    fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000,
    minIntervalMs = NANSEN_MIN_INTERVAL_MS, cacheTtlMs = NANSEN_CACHE_TTL_MS
  } = {}) {
    this.file = path.join(dir, 'nansen-settings.json'); this.fetchImpl = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
    this.minIntervalMs = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : NANSEN_MIN_INTERVAL_MS;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) && cacheTtlMs >= 0 ? cacheTtlMs : NANSEN_CACHE_TTL_MS;
    // 不恢复旧密钥备份，避免清除后意外重新启用。
    try {
      const settings = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!settings || Array.isArray(settings) || typeof settings.enabled !== 'boolean' || (settings.apiKey !== '' && !validKey(settings.apiKey)) || (settings.enabled && !settings.apiKey)) throw new Error('Invalid local settings');
      fs.chmodSync(this.file, 0o600);
      this.#apiKey = settings.apiKey;
      this.#enabled = settings.enabled;
    } catch (error) {
      if (error.code !== 'ENOENT') this.#configurationError = 'INVALID_LOCAL_CONFIG';
    }
  }
  snapshot() { return { enabled: this.#enabled, configured: Boolean(this.#apiKey), configurationError: this.#configurationError, supportedChains: Object.keys(CHAINS) }; }
  canReview() { return this.#enabled && Boolean(this.#apiKey) && this.now() >= this.#nextHttpAt && this.now() >= this.#cooldownUntil; }
  #save(enabled, apiKey) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // 凭证不保留历史备份；提交前清理旧备份，失败则不改变活动配置。
    fs.rmSync(`${this.file}.bak`, { force: true });
    const temp = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ enabled, apiKey }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      throw error;
    }
    this.#enabled = enabled; this.#apiKey = apiKey; this.#configurationError = ''; this.#revision++;
    for (const controller of this.#requests) controller.abort('CONFIG_CHANGED');
    return this.snapshot();
  }
  configure({ enabled, apiKey } = {}) {
    if (typeof enabled !== 'boolean' || (apiKey !== undefined && apiKey !== '' && !validKey(apiKey))) throw Object.assign(new Error('Nansen 配置无效。'), { statusCode: 400, code: 'INVALID_CONFIG' });
    const nextKey = apiKey === undefined || apiKey === '' ? this.#apiKey : apiKey;
    if (enabled && !nextKey) throw Object.assign(new Error('启用 Nansen 需要 API Key。'), { statusCode: 400, code: 'INVALID_CONFIG' });
    return this.#save(enabled, nextKey);
  }
  clear() { return this.#save(false, ''); }
  async review({ chain, address, deadline = Infinity } = {}) {
    const result = (status, errorCode = null, extra = {}) => nansenEvidence({ status, errorCode, checkedAt: this.now(), ...extra });
    const chainKey = typeof chain === 'string' ? chain.trim().toLowerCase() : '';
    if (!this.#enabled) return result('DISABLED');
    if (!this.#apiKey) return result('UNCONFIGURED');
    if (!Object.hasOwn(CHAINS, chainKey)) return result('UNSUPPORTED');
    if (!(chainKey === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(typeof address === 'string' ? address : '')) return result('ERROR', 'INVALID_ADDRESS');
    const cacheKey = `${chainKey}:${chainKey === 'sol' ? address : address.toLowerCase()}`;
    const cached = this.#cache.get(cacheKey);
    if (cached && (cached.status === 'OK' || cached.status === 'EMPTY')
      && this.cacheTtlMs > 0 && this.now() - cached.checkedAt < this.cacheTtlMs) {
      return nansenEvidence(cached);
    }
    const remaining = Math.min(this.timeoutMs, deadline - this.now());
    if (!(remaining > 0)) return result('TIME_BUDGET', 'TIMEOUT');
    if (this.now() < this.#nextHttpAt) return result('TIME_BUDGET', 'TIMEOUT');
    if (this.now() < this.#cooldownUntil) return result(...this.#cooldownResult);
    this.#nextHttpAt = this.now() + this.minIntervalMs;
    const revision = this.#revision, secret = this.#apiKey, controller = new AbortController();
    this.#requests.add(controller);
    const timeout = setTimeout(() => controller.abort('TIMEOUT'), remaining);
    let abortListener;
    const cancelled = new Promise((_, reject) => { abortListener = () => reject(Object.assign(new Error('cancelled'), { code: controller.signal.reason })); controller.signal.addEventListener('abort', abortListener, { once: true }); });
    try {
      const operation = async () => {
        const response = await this.fetchImpl('https://api.nansen.ai/api/v1/tgm/holders', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { apikey: secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ chain: CHAINS[chainKey], token_address: address, aggregate_by_entity: false, label_type: 'all_holders', premium_labels: false, pagination: { page: 1, per_page: 20 }, filters: { value_usd: { min: 0 } }, order_by: [{ field: 'ownership_percentage', direction: 'DESC' }] })
        });
        if (controller.signal.aborted || revision !== this.#revision) return result('CANCELLED', 'CONFIG_CHANGED');
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          let duration = retry !== null && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.now();
          if (!Number.isFinite(duration)) duration = 60000;
          this.#cooldownUntil = this.now() + Math.min(300000, Math.max(1000, duration));
          this.#cooldownResult = ['RATE_LIMITED', 'RATE_LIMITED'];
          void response.body?.cancel().catch(() => {}); return result('RATE_LIMITED', 'RATE_LIMITED');
        }
        if (!response.ok) {
          if ([401, 402, 403].includes(response.status)) { this.#cooldownUntil = this.now() + 60000; this.#cooldownResult = ['ERROR', 'HTTP_ERROR']; }
          void response.body?.cancel().catch(() => {}); return result('ERROR', 'HTTP_ERROR');
        }
        if (Number(response.headers.get('content-length')) > 1048576) { void response.body?.cancel().catch(() => {}); return result('ERROR', 'RESPONSE_TOO_LARGE'); }
        const reader = response.body?.getReader();
        if (!reader) return result('ERROR', 'INVALID_RESPONSE');
        let size = 0; const chunks = [];
        try {
          while (true) {
            const { done, value } = await Promise.race([reader.read(), cancelled]);
            if (done) break;
            size += value.byteLength;
            if (size > 1048576) { void reader.cancel().catch(() => {}); return result('ERROR', 'RESPONSE_TOO_LARGE'); }
            chunks.push(value);
          }
        } finally { if (controller.signal.aborted) void reader.cancel().catch(() => {}); reader.releaseLock(); }
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return result('ERROR', 'INVALID_RESPONSE'); }
        const p = json?.pagination;
        if (!Array.isArray(json?.data) || json.data.length > 20 || !p || p.page !== 1 || p.per_page !== 20 || typeof p.is_last_page !== 'boolean' || json.data.some(row => !row || typeof row !== 'object' || !holderAddress(row.address))) return result('ERROR', 'INVALID_RESPONSE');
        const holders = json.data.map(row => ({ address: row.address, label: label(row.address_label, secret), tokenAmount: number(row.token_amount), ownershipPercentage: number(row.ownership_percentage), balanceChange24h: number(row.balance_change_24h), valueUsd: number(row.value_usd) }));
        const evidence = result(holders.length ? 'OK' : 'EMPTY', null, { holders, hasMore: !p.is_last_page });
        if (this.cacheTtlMs > 0) this.#cache.set(cacheKey, evidence);
        return evidence;
      };
      const evidence = await Promise.race([operation(), cancelled]);
      return revision === this.#revision ? evidence : result('CANCELLED', 'CONFIG_CHANGED');
    } catch (error) {
      if (revision !== this.#revision || controller.signal.reason === 'CONFIG_CHANGED') return result('CANCELLED', 'CONFIG_CHANGED');
      if (controller.signal.reason === 'TIMEOUT') return result('TIME_BUDGET', 'TIMEOUT');
      return result('ERROR', 'NETWORK_ERROR');
    } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abortListener); this.#requests.delete(controller); }
  }
}
