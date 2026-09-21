import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chartRiskScreen, CHART_RISK_VERSION, applyRiskExclusion } from '../src/chart-risk.mjs';
import { RadarControls } from '../src/local-store.mjs';
import { config } from '../src/config.mjs';
import { deepScreen, knownRiskReasons, discoveryScreen, observeFiveMinutes } from '../src/scoring.mjs';
import { normalizeLiveRows } from '../src/live-discovery.mjs';
import { classifyDeepResult, reviewRevision, Scanner } from '../src/scanner.mjs';
import { toPublicStatus, createServer } from '../src/server.mjs';
import { RadarState } from '../src/state.mjs';
import { WatchPool } from '../src/watch-pool.mjs';

const now = 1_800_000_000_000, address = '0x' + 'a'.repeat(40);
const solAddress = 'SoL1111111111111111111111111111111111111111';

const series = (closes, at = now) => closes.map((close, i) => {
  const open = i ? closes[i - 1] : 1;
  return {
    time: at - (closes.length - i) * 60_000,
    open,
    close,
    high: Math.max(open, close) * 1.005,
    low: Math.min(open, close) * 0.995,
    volume: 100
  };
});

const pump = at => series([1.3776, 1.38, 1.38, 1.39, 1.39, 1.39, 1.40, 1.40, 1.40], at);
const dump = at => series([1, 0.65, 0.35, 0.18, 0.18, 0.18, 0.18, 0.18, 0.18], at);
const discovery = at => ({
  address,
  chain: 'bsc',
  market_cap: 50000,
  liquidity: 12000,
  creation_timestamp: at / 1000 - 600,
  rug_ratio: 0.1,
  bundler_rate: 0.05,
  rat_trader_amount_rate: 0.05,
  is_wash_trading: false,
  is_honeypot: false
});

test('knownRiskReasons两发现入口行为一致且与通用volume语义分离', () => {
  for (const fields of [
    { liquidity: 3310 },
    { buy_tax: '10%', sell_tax: '15%' },
    { dev_team_hold_rate: 0.0803 },
    { creator_balance_rate: 0.08 },
    { volume_5m: 0 }
  ]) {
    const row = { ...discovery(now), ...fields };
    assert.ok(knownRiskReasons(row, config).length > 0);
    assert.equal(discoveryScreen(row, { ...config, chain: 'bsc' }, now / 1000).pass, false);
    assert.equal(normalizeLiveRows([row], 'bsc', [], now).length, 0);
  }
  // 通用1m volume为0不能假定为5m成交为0
  assert.equal(normalizeLiveRows([{ ...discovery(now), volume: 0 }], 'bsc', [], now).length, 1);
});

test('DEV退出标签无法掩盖真实持仓或缺省持仓', () => {
  for (const status of ['sell', 'creator_close']) {
    for (const value of [0.0803, '8.03%', undefined, 0.50]) {
      const deep = deepScreen({
        discovery: { creator_token_status: status, dev_team_hold_rate: value },
        audit: {},
        nowMs: now
      }, config);
      assert.equal(deep.checks.dev, false);
      if (value === undefined) {
        assert.ok(deep.blockingUnknownFields.includes('devHold'));
      }
    }
  }
});

test('chartRiskScreen纯检测器可检测跳升窄平台和持续回撤，并正确识别乱序与时间单位', () => {
  for (const [bars, code] of [[pump(now), 'VERTICAL_PLATEAU'], [dump(now), 'SUSTAINED_COLLAPSE']]) {
    assert.equal(observeFiveMinutes(bars, now).pass, true);
    const risk = chartRiskScreen(bars, now);
    assert.equal(risk.status, 'REJECT');
    assert.ok(risk.codes.includes(code));
    assert.equal(risk.from, bars[0].time);
    assert.equal(chartRiskScreen([...bars].reverse(), now).status, 'REJECT');
    assert.equal(chartRiskScreen(bars.map(b => ({ ...b, time: b.time / 1000 })), now).status, 'REJECT');
  }
});

test('形态数据不足、冲突、断档、零量与价格跳空返回UNKNOWN且不永久定罪', () => {
  const good = series([1, 1.01, 1.02, 1.025, 1.03, 1.04, 1.05, 1.06]);
  assert.equal(chartRiskScreen(good, now).pass, true);
  assert.equal(chartRiskScreen([...good, good[0]], now).pass, true);

  const gapPrices = series([1, 1.5, 1.5, 1.5, 1.5, 1.5]).map(b => ({ ...b, open: b.close, low: b.close, high: b.close }));
  const cases = [
    [],
    good.slice(0, 3),
    good.slice(0, -3),
    [...good.slice(0, 3), ...good.slice(4)],
    [...good, { ...good[0], volume: 9 }],
    good.map(b => ({ ...b, time: b.time - 180000 })),
    good.map(b => ({ ...b, volume: 0 })),
    gapPrices,
    pump(now).map(b => ({ ...b, volume: 0 })),
    good.map(b => ({ ...b, open: [] }))
  ];

  for (const rows of cases) {
    const risk = chartRiskScreen(rows, now);
    assert.equal(risk.status, 'UNKNOWN');
    assert.equal(risk.pass, false);
    assert.equal(classifyDeepResult({
      chainPass: false,
      failed: ['chartRisk'],
      blockingUnknownFields: risk.unknownFields
    }).status, 'WAIT_RECHECK');
  }
  // 巨大高位上影线在没有连续收盘回撤时不算collapse
  assert.equal(chartRiskScreen(good.map(b => ({ ...b, high: 100 })), now).pass, true);
});

test('本地适配：chart命中REJECT作为当次保守WAIT_RECHECK，不设riskLatched且下次仍可重审', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-local-adapt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = new RadarState(dir);
  state.value.activeChain = 'bsc';
  const watchPool = new WatchPool(dir);

  let cycleAuditCount = 0;
  const gmgn = {
    keyEpoch: 1,
    configured: async () => true,
    discover: async () => [discovery(Date.now())],
    audit: async () => {
      cycleAuditCount++;
      if (cycleAuditCount === 1) {
        // 第1次：命中 VERTICAL_PLATEAU
        return {
          info: { liquidity: 15000, market_cap: 50000 },
          candles: pump(Date.now()),
          holders: { total: 200, items: [] }
        };
      }
      // 第2次：健康平稳 K 线
      return {
        info: { liquidity: 15000, market_cap: 50000 },
        candles: series([1, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06], Date.now()),
        holders: { total: 200, items: [] }
      };
    }
  };

  const scanner = new Scanner({
    state,
    gmgn,
    watchPool,
    settings: { ...config, chain: 'bsc', outcomeReadsPerCycle: 1 }
  });

  // 第1轮审计
  await scanner.cycle();
  assert.equal(cycleAuditCount, 1);
  const candidate1 = state.value.candidates[0];
  // 本地适配：必须是 WAIT_RECHECK，绝不强行打成永久 HARD_REJECT
  assert.equal(candidate1.status, 'WAIT_RECHECK');
  assert.equal(candidate1.deep.checks.chartRisk, false);
  assert.ok(candidate1.decisionReason.includes('单分钟跳升≥35%后窄幅平台'));

  // 验证 watchPool 记录包含 chartRisk 白名单证据，且未永久锁定 riskLatched
  const watchEntry = watchPool.snapshot('bsc').find(x => x.address === address);
  assert.ok(watchEntry);
  assert.equal(watchEntry.riskLatched, false);
  assert.ok(watchEntry.latest?.chartRisk);
  assert.equal(watchEntry.latest.chartRisk.status, 'REJECT');
  assert.ok(watchEntry.latest.chartRisk.codes.includes('VERTICAL_PLATEAU'));

  // 模拟时间流逝到到期时间，触发第2次 audit
  const internalEntry = watchPool.entries.get('bsc:' + address.toLowerCase());
  assert.ok(internalEntry.nextCheckAt > Date.now());
  internalEntry.nextCheckAt = Date.now() - 1000;
  watchPool.save();

  await scanner.cycle();
  assert.equal(cycleAuditCount, 2);
  const candidate2 = state.value.candidates[0];
  // 第2次样本恢复后重新评估通过（若其它条件符合）或得到 CLEAR_IN_WINDOW
  assert.equal(candidate2.deep.chartRisk.status, 'CLEAR_IN_WINDOW');
  assert.equal(candidate2.deep.checks.chartRisk, true);

  // 历史记录中仍保留第1次的 REJECT 记录，不冒充从未命中
  const watchEntryAfter = watchPool.snapshot('bsc').find(x => x.address === address);
  assert.equal(watchEntryAfter.history.length >= 2, true);
  assert.equal(watchEntryAfter.history[0].chartRisk?.status, 'REJECT');
});

test('已锁定的 riskLatched 即使 chartClear 也不恢复；暂停条目不执行 audit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-latched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = new RadarState(dir);
  state.value.activeChain = 'bsc';
  const watchPool = new WatchPool(dir);

  // 人工添加一条并将其 riskLatched
  watchPool.add({ chain: 'bsc', address });
  const entry = watchPool.entries.get(`bsc:${address.toLowerCase()}`);
  entry.riskLatched = true;
  entry.nextCheckAt = Date.now() - 1000;
  watchPool.save();

  let audited = false;
  const gmgn = {
    keyEpoch: 1,
    configured: async () => true,
    discover: async () => [],
    audit: async () => {
      audited = true;
      return { candles: series([1, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06], Date.now()) };
    }
  };

  // 暂停条目不审
  watchPool.setPaused({ chain: 'bsc', address, paused: true });
  assert.equal(watchPool.due('bsc', Date.now(), 1).length, 0);

  // 取消暂停后由于 riskLatched，即使 audit 返回 clear，watchPool.record 后 riskLatched 依旧为 true
  watchPool.setPaused({ chain: 'bsc', address, paused: false });
  assert.equal(watchPool.due('bsc', Date.now(), 1).length, 1);
  watchPool.record({
    chain: 'bsc',
    address,
    status: 'X_REVIEW',
    deep: {
      chainPass: true,
      chartRisk: { version: CHART_RISK_VERSION, status: 'CLEAR_IN_WINDOW', pass: true }
    }
  });
  const updated = watchPool.snapshot('bsc').find(x => x.address === address);
  assert.equal(updated.riskLatched, true);
});

test('旧无版本候选在服务启动和导出时统一降级为 WAIT_RECHECK 且失效人工 revision', () => {
  const legacyCandidate = {
    chain: 'bsc',
    address,
    symbol: 'OLD',
    status: 'X_REVIEW',
    auditedAt: Date.now() - 60000,
    reviewRevision: 'legacy-revision-123',
    decisionReason: '旧版全部通过',
    deep: {
      chainPass: true,
      checks: { openSource: true, dev: true }
      // 没有 chartRisk
    }
  };

  const status = toPublicStatus({
    activeChain: 'bsc',
    candidates: [legacyCandidate]
  });

  const row = status.candidates[0];
  assert.equal(row.status, 'WAIT_RECHECK');
  assert.equal(row.deep.chainPass, false);
  assert.equal(row.decisionReason, '风险规则已升级，等待重新核验');
  assert.equal(row.deep.chartRisk.version, 0);

  // 验证 reviewRevision 已失效
  const newCandidate = {
    ...legacyCandidate,
    deep: {
      ...legacyCandidate.deep,
      chartRisk: { version: CHART_RISK_VERSION, status: 'CLEAR_IN_WINDOW', pass: true }
    }
  };
  assert.notEqual(reviewRevision(legacyCandidate), reviewRevision(newCandidate));
});

test('discovery 新增不利事实时旧 snapshot 即使无深审位也立即降为 WAIT_RECHECK', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-downgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = new RadarState(dir);
  state.value.activeChain = 'bsc';
  // 预置一个原本 X_REVIEW 的旧 snapshot
  state.value.candidates = [{
    chain: 'bsc',
    address,
    symbol: 'TEST',
    status: 'X_REVIEW',
    auditedAt: Date.now() - 60000,
    reviewRevision: 'valid-rev',
    decisionReason: '',
    deep: {
      chainPass: true,
      chartRisk: { version: CHART_RISK_VERSION, status: 'CLEAR_IN_WINDOW', pass: true }
    }
  }];

  // 新 discovery 出现不利事实：如流动性跌破 strictLiquidity
  const adverseRow = { ...discovery(Date.now()), liquidity: 2000 };
  const gmgn = {
    keyEpoch: 1,
    configured: async () => true,
    discover: async () => [adverseRow],
    audit: async () => { throw new Error('PROVIDER_FAILED'); }
  };

  const scanner = new Scanner({
    state,
    gmgn,
    settings: { ...config, chain: 'bsc', maxDeepAuditsPerCycle: 0 } // 不给深审位
  });

  await scanner.cycle();

  // 必须立即降为 WAIT_RECHECK，不能因无深审位或后续错误而维持 X_REVIEW
  const candidate = state.value.candidates.find(x => x.address === address);
  assert.ok(candidate);
  assert.equal(candidate.status, 'WAIT_RECHECK');
  assert.equal(candidate.deep.chainPass, false);
  assert.ok(candidate.decisionReason.includes('流动性低于深审门槛'));
  assert.notEqual(candidate.reviewRevision, 'valid-rev');
});

test('Solana 大小写保持与 tokenKey 跨链隔离', () => {
  const solUpper = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
  const evmAddress = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';

  const rows = normalizeLiveRows([
    { ...discovery(Date.now()), chain: 'sol', address: solUpper, is_wash_trading: false },
    { ...discovery(Date.now()), chain: 'bsc', address: evmAddress, is_wash_trading: false }
  ], 'sol', [], Date.now());

  // sol 入口只识别 sol，不接受 bsc
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, solUpper); // 必须严格保留大小写，绝不大写转小写
});

test('形态永久排除默认关闭；打开后写入排除表并不再复查', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-exclusion-toggle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controls = new RadarControls(dir, ['bsc'], 'bsc');
  assert.equal(controls.value.chartRiskExclusion, false);
  const state = new RadarState(dir);
  state.value.activeChain = 'bsc';
  const watchPool = new WatchPool(dir);
  let cycleAuditCount = 0;
  const gmgn = {
    keyEpoch: 1, configured: async () => true, discover: async () => [discovery(Date.now())],
    audit: async () => {
      cycleAuditCount += 1;
      return { info: { liquidity: 15000, market_cap: 50000 }, candles: pump(Date.now()), holders: { total: 200, items: [] } };
    }
  };
  const scanner = new Scanner({ state, gmgn, watchPool, controls, settings: { ...config, chain: 'bsc', outcomeReadsPerCycle: 1 } });
  await scanner.cycle();
  assert.equal(state.value.candidates[0].status, 'WAIT_RECHECK');
  assert.equal(Object.keys(state.value.riskExclusions || {}).length, 0);

  controls.setChartRiskExclusion(true);
  const held = applyRiskExclusion(state.value.candidates[0], {
    ['bsc:' + address]: { reasons: ['单分钟跳升≥35%后窄幅平台，当次不通过，等待复查'] }
  }, 'bsc');
  assert.equal(held.status, 'HARD_REJECT');

  const dueNow = () => {
    const item = watchPool.entries.get('bsc:' + address.toLowerCase());
    item.nextCheckAt = Date.now() - 1000;
    watchPool.save();
    const queued = state.value.auditQueue?.find(row => row.address === address);
    if (queued) queued.nextAuditAt = 0;
  };
  dueNow();
  cycleAuditCount = 0;
  await scanner.cycle();
  assert.equal(cycleAuditCount, 1);
  assert.equal(state.value.candidates[0].status, 'HARD_REJECT');
  assert.ok(state.value.riskExclusions['bsc:' + address]);
  const live = scanner.enqueueReview('bsc', discovery(Date.now()));
  assert.equal(live.accepted, false);
  assert.equal(live.reason, 'risk_excluded');

  dueNow();
  const before = cycleAuditCount;
  await scanner.cycle();
  assert.equal(cycleAuditCount, before);

  controls.setChartRiskExclusion(false);
  dueNow();
  await scanner.cycle();
  assert.ok(cycleAuditCount > before);
});

test('观察池不把缺失 chartRisk 版本写成当前规则', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-risk-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = new WatchPool(dir);
  pool.add({ chain: 'bsc', address });
  pool.record({
    chain: 'bsc',
    address,
    status: 'WAIT_RECHECK',
    deep: { chartRisk: { status: 'UNKNOWN', pass: false, reasons: ['形态数据不足、冲突、断档或过期，等待复核'] } }
  });
  const item = pool.snapshot('bsc')[0];
  assert.equal(item.latest.chartRisk.status, 'UNKNOWN');
  assert.equal(item.latest.chartRisk.version, 0);
  assert.notEqual(item.latest.chartRisk.version, CHART_RISK_VERSION);
});
