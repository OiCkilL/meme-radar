import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../src/config.mjs';
import { NansenIntegration } from '../src/nansen.mjs';
import { WatchPool } from '../src/watch-pool.mjs';
import { RadarState } from '../src/state.mjs';
import { Scanner } from '../src/scanner.mjs';
import { createServer } from '../src/server.mjs';

const TEST_SECRET_KEY = 'nansen-secret-key-12345678';
const EVM_ADDRESS = '0x' + '1'.repeat(40);
const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';

function fixture(t, { fetchImpl = async () => new Response('{}', { status: 200 }), gmgnOverrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = new RadarState(dir);
  const watchPool = new WatchPool(dir);
  const nansen = new NansenIntegration(dir, { fetchImpl, timeoutMs: 300, minIntervalMs: 0, cacheTtlMs: 0 });

  const gmgn = {
    keyEpoch: 0,
    metrics: {},
    configured: async () => true,
    discover: async () => [],
    audit: async () => ({
      info: { price: { price: 1.5 }, circulating_supply: 1000000, liquidity: 50000 },
      security: { honeypot: false },
      pool: {},
      holders: [],
      traders: [],
      candles: [],
      _meta: { complete: true }
    }),
    ...gmgnOverrides
  };

  const settings = {
    ...config,
    port: 3791,
    stateDir: dir,
    auditCycleBudgetMs: 2000,
    publicDir: path.resolve('public')
  };

  const scanner = new Scanner({ gmgn, nansen, watchPool, state, settings });
  const server = createServer({ state, settings, watchPool, nansen, supportedChains: config.supportedChains });

  return { dir, state, watchPool, nansen, gmgn, scanner, server, settings };
}

async function dispatch(server, { method = 'POST', url = '/api/nansen-settings', body = undefined, origin = 'http://127.0.0.1:3791' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3791', origin, 'content-type': 'application/json' }
  });
  return new Promise((resolve, reject) => {
    let code = 200;
    Promise.resolve(server.listeners('request')[0](req, {
      setHeader() {},
      writeHead(v) { code = v; },
      end(v) {
        try {
          resolve({ code, body: v ? JSON.parse(v) : null });
        } catch {
          resolve({ code, raw: v });
        }
      }
    })).catch(reject);
  });
}

function mockNansenPayload(holders = []) {
  return {
    data: holders.map((h, i) => ({
      address: h.address,
      address_label: h.label ?? `Holder ${i + 1}`,
      token_amount: h.tokenAmount ?? 1000,
      ownership_percentage: h.ownershipPercentage ?? 5.5,
      balance_change_24h: h.balanceChange24h ?? 0,
      value_usd: h.valueUsd ?? 2500,
      extra_upstream_secret: 'upstream-secret-leak'
    })),
    pagination: { page: 1, per_page: 20, is_last_page: true }
  };
}

test('1. API 保存开启 -> 复查触发(支持 robinhood 与 sol 大小写) -> 白名单证据持久化与 export 导出', async t => {
  const interceptedRequests = [];
  const { server, scanner, watchPool, dir } = fixture(t, {
    fetchImpl: async (url, options) => {
      interceptedRequests.push({ url, ...options, body: JSON.parse(options.body) });
      const address = JSON.parse(options.body).token_address;
      return Response.json(mockNansenPayload([
        { address, label: 'Whale Alpha', tokenAmount: 5000, ownershipPercentage: 10, valueUsd: 15000 }
      ]));
    }
  });

  // 1) 初始验证：Nansen 未配置且默认关闭
  const initialStatus = await dispatch(server, { method: 'GET', url: '/api/status' });
  assert.equal(initialStatus.body.nansen.enabled, false);
  assert.equal(initialStatus.body.nansen.configured, false);

  // 2) API 保存并开启
  const saveResp = await dispatch(server, {
    method: 'POST',
    url: '/api/nansen-settings',
    body: { enabled: true, apiKey: TEST_SECRET_KEY }
  });
  assert.equal(saveResp.code, 200);
  assert.equal(saveResp.body.saved, true);
  assert.equal(saveResp.body.nansen.enabled, true);
  assert.equal(saveResp.body.nansen.configured, true);

  // 3) 添加 robinhood 与 sol(大小写测试) 观察池条目并触发复查
  watchPool.add({ chain: 'robinhood', address: EVM_ADDRESS, reportedOutcome: '' });
  watchPool.add({ chain: 'sol', address: SOL_ADDRESS, reportedOutcome: '' });

  // 运行 robinhood 链 cycle
  await scanner.cycle();
  // 切换并运行 sol 链 cycle
  scanner.activateChain('sol');
  await scanner.cycle();

  // 验证 interceptor 捕获到两个链的请求
  assert.equal(interceptedRequests.length, 2);
  const rhReq = interceptedRequests.find(r => r.body.token_address === EVM_ADDRESS);
  const solReq = interceptedRequests.find(r => r.body.token_address === SOL_ADDRESS);

  assert.ok(rhReq, 'robinhood 请求已发出');
  assert.equal(rhReq.body.chain, 'robinhood');
  assert.equal(rhReq.headers.apikey, TEST_SECRET_KEY);
  assert.equal(rhReq.body.premium_labels, false);

  assert.ok(solReq, 'sol 请求已发出');
  assert.equal(solReq.body.chain, 'solana');
  assert.equal(solReq.body.token_address, SOL_ADDRESS); // 保持 Base58 大小写
  assert.equal(solReq.headers.apikey, TEST_SECRET_KEY);

  // 4) 验证 watchPool 持久化证据与白名单结构
  const rhEntry = watchPool.snapshot('robinhood').find(e => e.address === EVM_ADDRESS);
  assert.equal(rhEntry.latest.nansen.status, 'OK');
  assert.equal(rhEntry.latest.nansen.sampleCount, 1);
  assert.equal(rhEntry.latest.nansen.holders[0].address, EVM_ADDRESS);
  assert.equal(rhEntry.latest.nansen.holders[0].label, 'Whale Alpha');

  // 5) 验证直接调用带有大写 'SOL' / 'Sol' 的 review 方法能够映射并保留地址大小写
  const { nansen } = fixture(t, {
    fetchImpl: async (url, options) => {
      interceptedRequests.push({ url, ...options, body: JSON.parse(options.body) });
      return Response.json(mockNansenPayload([{ address: SOL_ADDRESS }]));
    }
  });
  nansen.configure({ enabled: true, apiKey: TEST_SECRET_KEY });
  const solUpperReview = await nansen.review({ chain: 'SOL', address: SOL_ADDRESS });
  assert.equal(solUpperReview.status, 'OK');
  const solUpperReq = interceptedRequests.at(-1);
  assert.equal(solUpperReq.body.chain, 'solana');
  assert.equal(solUpperReq.body.token_address, SOL_ADDRESS);

  // 6) 验证 export 接口输出不包含敏感 Key
  const exportResp = await dispatch(server, { method: 'GET', url: '/api/export' });
  assert.equal(exportResp.code, 200);
  const exportJson = JSON.stringify(exportResp.body);
  assert.equal(exportJson.includes(TEST_SECRET_KEY), false, 'export 绝不包含 Nansen API Key');
  assert.equal(exportJson.includes('upstream-secret-leak'), false, 'export 绝不包含上游未白名单字段');
  assert.ok(exportResp.body.watchPool.some(r => r.latest?.nansen?.status === 'OK'));
});

test('2. 进程重建后配置持久保留', async t => {
  const { server, dir } = fixture(t);

  // 通过 API 保存配置
  await dispatch(server, {
    method: 'POST',
    url: '/api/nansen-settings',
    body: { enabled: true, apiKey: TEST_SECRET_KEY }
  });

  // 模拟重启进程：新建 NansenIntegration 实例读取同一目录
  const restoredNansen = new NansenIntegration(dir);
  const snap = restoredNansen.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.configured, true);
  assert.equal(snap.configurationError, '');

  // 验证权限为私有 0o600
  const stat = fs.statSync(path.join(dir, 'nansen-settings.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('3. 关闭后复查 0 额外 Nansen 调用，GMGN 扫描继续正常工作', async t => {
  let nansenCalls = 0;
  const { server, scanner, watchPool } = fixture(t, {
    fetchImpl: async () => {
      nansenCalls++;
      return Response.json(mockNansenPayload());
    }
  });

  // 保存并启用
  await dispatch(server, {
    method: 'POST',
    url: '/api/nansen-settings',
    body: { enabled: true, apiKey: TEST_SECRET_KEY }
  });

  watchPool.add({ chain: 'robinhood', address: EVM_ADDRESS });
  await scanner.cycle();
  assert.equal(nansenCalls, 1, '启用时产生了 1 次 Nansen 复查调用');

  // 关闭 Nansen（仅 toggle enabled，不清除 key）
  const toggleResp = await dispatch(server, {
    method: 'POST',
    url: '/api/nansen-settings',
    body: { enabled: false }
  });
  assert.equal(toggleResp.code, 200);
  assert.equal(toggleResp.body.nansen.enabled, false);
  assert.equal(toggleResp.body.nansen.configured, true);

  // 再次重置 nextCheckAt 触发复查
  const entry = watchPool.entries.get(`robinhood:${EVM_ADDRESS}`);
  entry.nextCheckAt = 0;

  await scanner.cycle();
  assert.equal(nansenCalls, 1, '关闭后没有产生额外 Nansen 调用 (0 额外调用)');

  // 确认 GMGN 依然成功更新了观察历史
  const updated = watchPool.snapshot('robinhood')[0];
  assert.equal(updated.checkCount, 2);
  assert.equal(updated.history.length, 2);
});

test('4. 清除后 Key 不在配置文件、备份文件或状态导出中', async t => {
  const { server, dir } = fixture(t);

  // 先配置
  await dispatch(server, {
    method: 'POST',
    url: '/api/nansen-settings',
    body: { enabled: true, apiKey: TEST_SECRET_KEY }
  });

  // 人为制造一个残留的 .bak 文件以验证清除策略
  fs.writeFileSync(path.join(dir, 'nansen-settings.json.bak'), JSON.stringify({ apiKey: TEST_SECRET_KEY }));

  // 执行清除
  const clearResp = await dispatch(server, {
    method: 'POST',
    url: '/api/nansen-settings',
    body: { action: 'clear' }
  });
  assert.equal(clearResp.code, 200);
  assert.equal(clearResp.body.nansen.enabled, false);
  assert.equal(clearResp.body.nansen.configured, false);

  // 检查磁盘文件
  const files = fs.readdirSync(dir);
  assert.equal(files.includes('nansen-settings.json.bak'), false, '备份文件已被清理删除');

  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(content.includes(TEST_SECRET_KEY), false, `文件 ${f} 中不包含密钥`);
  }

  // 检查 API 返回
  const statusResp = await dispatch(server, { method: 'GET', url: '/api/status' });
  assert.equal(statusResp.body.nansen.configured, false);
  assert.equal(JSON.stringify(statusResp.body).includes(TEST_SECRET_KEY), false);
});

test('5. Nansen 403 / 超时 / unsupported 链不影响 GMGN 原判定与观察历史记录', async t => {
  // 5.1 验证 403 异常处理及冷却防护
  let upstreamCalls = 0;
  const f403 = fixture(t, {
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response('Forbidden', { status: 403 });
    }
  });

  f403.nansen.configure({ enabled: true, apiKey: TEST_SECRET_KEY });
  f403.watchPool.add({ chain: 'robinhood', address: EVM_ADDRESS });

  await f403.scanner.cycle();
  let item403 = f403.watchPool.snapshot('robinhood')[0];
  assert.equal(item403.latest.status, 'WAIT_RECHECK', 'GMGN 判定保持 WAIT_RECHECK');
  assert.equal(item403.latest.nansen.status, 'ERROR');
  assert.equal(item403.latest.nansen.errorCode, 'HTTP_ERROR');
  assert.equal(item403.history.length, 1, '历史记录未丢失');
  assert.equal(upstreamCalls, 1);

  // 冷却期内再次复查不打扰上游
  f403.watchPool.entries.get(`robinhood:${EVM_ADDRESS}`).nextCheckAt = 0;
  await f403.scanner.cycle();
  assert.equal(upstreamCalls, 1, '403 冷却期内不向外部发送新请求');

  // 5.2 验证超时异常处理
  const fTimeout = fixture(t, {
    fetchImpl: async () => new Promise(() => {}) // 挂起触发超时
  });
  fTimeout.nansen.configure({ enabled: true, apiKey: TEST_SECRET_KEY });
  fTimeout.watchPool.add({ chain: 'robinhood', address: EVM_ADDRESS });

  await fTimeout.scanner.cycle();
  const itemTimeout = fTimeout.watchPool.snapshot('robinhood')[0];
  assert.equal(itemTimeout.latest.status, 'WAIT_RECHECK');
  assert.equal(itemTimeout.latest.nansen.status, 'TIME_BUDGET');
  assert.equal(itemTimeout.latest.nansen.errorCode, 'TIMEOUT');
  assert.equal(itemTimeout.history.length, 1);

  // 5.3 验证 unsupported 链 (例如 arc / stable) 直接跳过 Nansen 但雷达功能正常
  const arcReview = await f403.nansen.review({ chain: 'arc', address: EVM_ADDRESS });
  assert.equal(arcReview.status, 'UNSUPPORTED');
  assert.equal(arcReview.holders.length, 0);

  const stableReview = await f403.nansen.review({ chain: 'stable', address: EVM_ADDRESS });
  assert.equal(stableReview.status, 'UNSUPPORTED');
});

test('6. 损坏 Nansen 本地配置不阻断普通 GMGN 发现与深审扫描', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 写入损坏的配置 JSON
  fs.writeFileSync(path.join(dir, 'nansen-settings.json'), '{corrupt-json-structure');

  const state = new RadarState(dir);
  const watchPool = new WatchPool(dir);
  const nansen = new NansenIntegration(dir);
  assert.equal(nansen.snapshot().configurationError, 'INVALID_LOCAL_CONFIG');
  assert.equal(nansen.snapshot().enabled, false);

  // 模拟普通 GMGN 发现新 token
  const gmgn = {
    keyEpoch: 0,
    metrics: {},
    configured: async () => true,
    discover: async () => [{
      address: EVM_ADDRESS,
      market_cap: 50000,
      liquidity: 20000,
      creation_timestamp: Math.floor(Date.now() / 1000) - 600,
      rug_ratio: 0.1,
      bundler_rate: 0.1,
      rat_trader_amount_rate: 0.1,
      is_wash_trading: false,
      is_honeypot: false
    }],
    audit: async () => ({
      info: { price: { price: 2.0 }, circulating_supply: 500000, liquidity: 20000 },
      security: { honeypot: false },
      pool: {},
      holders: [],
      traders: [],
      candles: [],
      _meta: { complete: true }
    })
  };

  const scanner = new Scanner({ gmgn, nansen, watchPool, state, settings: config });
  // 运行周期：必须能够顺利完成扫描，不抛出异常，不被中断
  await scanner.cycle();

  assert.equal(state.value.candidates.length, 1);
  assert.equal(state.value.candidates[0].address, EVM_ADDRESS);
  // 首次普通发现深审不调用 Nansen，即便配置损坏也毫无影响
  assert.equal(state.value.candidates[0].nansen, null);

  // 损坏配置可通过正常 configure 重新覆写修复
  nansen.configure({ enabled: true, apiKey: TEST_SECRET_KEY });
  assert.equal(nansen.snapshot().configurationError, '');
  assert.equal(nansen.snapshot().enabled, true);
});
