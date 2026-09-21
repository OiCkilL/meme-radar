import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

test('所有内联脚本均可通过语法解析', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('所有显式像素字号均不小于14像素', () => {
  const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every(size => size >= 14));
});

test('看板明确区分累计、本轮和近30分钟口径', () => {
  assert.match(html, /<h1[^>]*>Meme雷达开源版<\/h1>/);
  assert.match(html, /class="mark"[^>]*>[\s\S]*?<svg/);
  assert.match(html, /扫描轮次[\s\S]*累计/);
  assert.match(html, /发现代币[\s\S]*本轮/);
  assert.match(html, /深度审计[\s\S]*近30分钟/);
  assert.match(html, /链上候选\/待人工看X/);
  assert.doesNotMatch(html, /最终候选/);
});

test('人工复核仅保存本地标记且不包含交易入口', () => {
  assert.match(html, /robinhoodRadarManualMarksV1/);
  assert.match(html, /data-action="pass"/);
  assert.match(html, /data-action="ignore"/);
  assert.match(html, /复制合约/);
  assert.match(html, /官网无/);
  assert.match(html, /访问官网/);
  assert.match(html, /safeUrl\(row\.info && row\.info\.website\)/);
  assert.match(html, /officialXHandle/);
  assert.match(html, /normalizeXHandle/);
  assert.match(html, /reservedXPaths/);
  assert.match(html, /普通钱包代理数量未知/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /只扫描、不交易/);
});

test('AVE 打开代币页且不含邀请码或推荐参数', () => {
  assert.match(html, /id="ave-api-key"[^>]*type="password"/);
  assert.match(html, /id="ave-key-form"/);
  assert.doesNotMatch(html, /share\.ave\.ai|AVE_INVITE_URL|AVE_REFERRAL_CODE|\?ref=|code=0001/);
  const start = html.indexOf('const AVE_EVM_CHAINS');
  const end = html.indexOf('function actionLinks', start);
  assert.ok(start > 0 && end > start);
  const context = {};
  vm.runInNewContext(html.slice(start, end) + ';this.tokenUrl = aveTokenUrl;', context);
  assert.equal(context.tokenUrl('bsc', '0x059ecb64e45b6211f1390d5f28cc909203ca7777'),
    'https://pro.ave.ai/token/0x059ecb64e45b6211f1390d5f28cc909203ca7777-bsc');
  assert.equal(context.tokenUrl('sol', 'So11111111111111111111111111111111111111112'),
    'https://pro.ave.ai/token/So11111111111111111111111111111111111111112-solana');
  assert.equal(context.tokenUrl('unknown', '0x059ecb64e45b6211f1390d5f28cc909203ca7777'), null);
  assert.match(html, /t\('aveTrade'\)/);
  assert.match(html, /gmgnDetails/);
});

test('语音提醒面板存在且不依赖永久排除表', () => {
  assert.match(html, /id="voiceEnable"/);
  assert.match(html, /id="voiceVolume"/);
  assert.match(html, /src="\/voice-ui\.mjs"/);
  assert.match(html, /voiceSnapshot/);
  assert.doesNotMatch(html, /riskExclusions/);
  const footer = html.slice(html.indexOf('class="footer"'), html.indexOf('id="toast"'));
  assert.match(footer, /class="voice-panel"/);
  assert.match(footer, /id="voiceHelp"/);
  assert.match(footer, /footerLocal/);
  assert.ok(footer.indexOf('voice-panel') < footer.indexOf('footerLocal'));
});

test('设置弹窗只有主体滚动且深色沿用页面色板', () => {
  assert.match(html, /\.settings-dialog\[open\]\s*\{[\s\S]*?display:\s*flex/);
  assert.match(html, /\.settings-dialog\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(html, /\.settings-dialog\s*\{[\s\S]*?max-width:\s*min\(1120px/);
  assert.match(html, /\.settings-dialog\s*\{[\s\S]*?color-scheme:\s*dark/);
  assert.match(html, /\.settings-body\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(html, /\.settings-body\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(html, /\.settings-card\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(html, /\.settings-card\s*\{[\s\S]*?flex:\s*0 0 auto/);
  assert.match(html, /\.settings-dialog\s*\{[\s\S]*?background:\s*var\(--bg-surface\)/);
  assert.match(html, /dialog\.settings-dialog \.settings-card\s*\{[\s\S]*?background:\s*#151d26/);
  assert.match(html, /dialog\.settings-dialog \.settings-card\s*\{[\s\S]*?appearance:\s*none/);
  assert.match(html, /html\[data-theme="dark"\] \.settings-dialog \.settings-card\s*\{[\s\S]*?background:\s*#151d26 !important/);
  assert.match(html, /html\[data-theme="dark"\] \.settings-dialog \.settings-card-title[\s\S]*?color:\s*#f1f5f9 !important/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(html, /<section class="settings-card"/);
  assert.doesNotMatch(html, /html\[data-theme="dark"\] \.settings-card \{\s*background: #0a0e13/);
  const titleBlocks = [...html.matchAll(/<h3[^>]*class="settings-card-title"[^>]*>([\s\S]*?)<\/h3>/g)].map(m => m[1]);
  assert.equal(titleBlocks.length, 4);
  for (const block of titleBlocks) {
    assert.match(block, /<svg class="lucide"/);
    assert.match(block, /<span/);
  }
});

test('形态风险展示为复查，旧规则版本不能被人工标成通过', () => {
  assert.match(html, /code === 'chartRisk'/);
  assert.match(html, /row\.deep\.chartRisk\.version !== 1/);
  assert.match(html, /if \(row\.status === 'X_REVIEW' \|\| row\.status === 'QUALIFIED' \|\| row\.deep\.chainPass\) return 'waiting'/);
  assert.match(html, /id="chartRiskExclusionEnabled"/);
  assert.doesNotMatch(html, /applyRiskExclusion/);
});

test('前端X入口拒绝站内功能页并只生成单层用户名链接', () => {
  const start = html.indexOf('const reservedXPaths = new Set(');
  const end = html.indexOf('function officialXHandle', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL };
  vm.runInNewContext(html.slice(start, end) + '\nthis.normalize = normalizeXHandle;', context);
  assert.equal(context.normalize('https://x.com/search?q=test'), '');
  assert.equal(context.normalize('https://x.com/home'), '');
  assert.equal(context.normalize('x.com/real_handle'), 'real_handle');
  assert.equal(context.normalize('@real_handle'), 'real_handle');
  assert.equal(context.normalize('https://example.com/x.com/fake'), '');
  assert.equal('https://x.com/' + encodeURIComponent(context.normalize('x.com/real_handle')), 'https://x.com/real_handle');
});

test('六语切换持久化并支持阿拉伯语RTL', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar']) {
    assert.match(html, new RegExp('<option value="' + locale + '"'));
  }
  assert.match(html, /memeRadarLanguageV1/);
  assert.match(html, /document\.documentElement\.dir = currentLocale === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(html, /html\[dir="rtl"\]/);
  assert.match(html, /data-i18n="appTitle"/);
  assert.match(html, /data-i18n="auditTitle"/);
  assert.match(html, /t\(statusKeys\[data\.status\]/);
  assert.doesNotMatch(html, /GMGN多链候选雷达 · 只扫描、只筛选、永不下单/);
});

test('语言下拉使用地球图标和深色高对比选项', () => {
  assert.match(html, /class="language-icon" aria-hidden="true">[\s\S]*?<svg/);
  assert.match(html, /class="visually-hidden" data-i18n="languageLabel">语言<\/span>/);
  assert.match(html, /\.language-select\s*\{[\s\S]*?color-scheme:\s*dark/);
  assert.match(html, /\.language-select option\s*\{[\s\S]*?background:\s*#0b151a;[\s\S]*?color:\s*#f2faf8/);
  assert.match(html, /\.language-select:focus-visible\s*\{[\s\S]*?outline:\s*1px solid #61cbd4/);
  assert.doesNotMatch(html, /\.language-select\s*\{[\s\S]*?background:\s*transparent/);
});

test('翻译词典完整覆盖静态挂点和动态文案键', () => {
  const dictionarySource = html.match(/const messages = (\{[\s\S]*?\n    \});\n\n    let currentLocale/);
  assert.ok(dictionarySource, '应能提取翻译词典');
  const messages = vm.runInNewContext('(' + dictionarySource[1] + ')');
  for (const [key, values] of Object.entries(messages)) {
    assert.ok(Array.isArray(values), key + ' 应为数组');
    assert.equal(values.length, 6, key + ' 应包含六种语言');
    assert.ok(values.every(value => typeof value === 'string' && value.length > 0), key + ' 不应有空翻译');
  }
  const staticKeys = [...html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)].map(match => match[1]);
  const dynamicKeys = [...html.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]);
  for (const key of new Set([...staticKeys, ...dynamicKeys])) assert.ok(messages[key], '缺少翻译键：' + key);
});

test('多链切换仅向本地后端提交白名单链标识', () => {
  for (const chain of ['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']) {
    assert.match(html, new RegExp("id: '" + chain + "'"));
  }
  assert.match(html, /fetch\('\/api\/active-chain'/);
  assert.match(html, /JSON\.stringify\(\{ chain: chain \}\)/);
  assert.match(html, /renderChainSwitcher\(null\)/);
});

test('页面不再公开展示严格筛选规则', () => {
  assert.doesNotMatch(html, /严格筛选标准/);
  assert.doesNotMatch(html, /Strict screening rules/);
  assert.doesNotMatch(html, /data-i18n="criterion[1-8]"/);
  assert.doesNotMatch(html, /\bcriteriaTitle\s*:/);
  assert.doesNotMatch(html, /class="criteria"/);
});

test('GMGN密钥仅提交给同源接口且不会持久化或回显', () => {
  assert.match(html, /id="gmgnKeyInput"[^>]*type="password"[^>]*autocomplete="off"[^>]*spellcheck="false"[^>]*maxlength="256"/);
  assert.match(html, /id="gmgnKeyButton"[^>]*data-i18n-aria="gmgnApiSubmitAria"/);
  assert.match(html, /id="gmgnKeyStatus"[^>]*aria-live="polite"/);
  const start = html.indexOf('async function connectGmgnApi');
  const end = html.indexOf('async function refresh', start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  assert.match(source, /fetch\('\/api\/gmgn-key'/);
  assert.match(source, /body: JSON\.stringify\(\{ apiKey: apiKey \}\)/);
  assert.match(source, /input\.value = ''/);
  assert.match(source, /t\('gmgnApiConnected'\)/);
  assert.match(source, /result\.verified !== true/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|readStorage|writeStorage/);
  assert.doesNotMatch(source, /console\.|innerHTML|textContent\s*=\s*result\./);
});

test('新用户无需Agent即可生成GMGN公钥且页面绝不请求私钥', () => {
  assert.match(html, /id="gmgnOnboardingButton"/);
  assert.match(html, /id="gmgnPublicKey"[^>]*readonly/);
  assert.match(html, /fetch\('\/api\/gmgn-onboarding'/);
  assert.match(html, /每次创建新的 GMGN API Key，都必须重新完成 Agent 公钥绑定/);
  assert.match(html, /JSON\.stringify\(\{ regenerate: regenerate === true \}\)/);
  assert.match(html, /只开启“允许读取”，务必关闭“允许交易”/);
  assert.doesNotMatch(html, /gmgn-private-key|privateKey\s*=/);
});

test('看板包含新鲜度、运行进度和动态降级支持', () => {
  assert.match(html, /最近扫描尝试/);
  assert.match(html, /最近成功扫描/);
  assert.match(html, /下轮扫描/);
  assert.match(html, /数据新鲜度/);
  assert.match(html, /scanInProgress/);
  assert.match(html, /WAIT_RECHECK/);
  assert.match(html, /HARD_REJECT/);
  assert.match(html, /筛选后表现验证/);
  assert.match(html, /30分钟结果/);
  assert.match(html, /2小时结果/);
  assert.match(html, /24小时结果/);
  assert.match(html, /未满50个只做观察，不用于调参/);
  assert.match(html, /prefers-reduced-motion/);
});

test('候选表明确展示GoPlus与DexScreener交叉验证', () => {
  assert.match(html, /GoPlus一票否决/);
  assert.match(html, /GoPlus未见致命项/);
  assert.match(html, /Dex复核/);
  assert.match(html, /多源数据冲突/);
});

test('支持深色浅色与系统三态主题且首屏粒子图层不挤占内容流', () => {
  assert.match(html, /id="themeSelect"/);
  assert.match(html, /id="themeIcon"/);
  assert.match(html, /data-i18n="themeLabel"/);
  assert.match(html, /html\[data-theme="light"\]/);
  assert.match(html, /data-theme['"]\s*,\s*['"]dark['"]/);
  assert.match(html, /@media\s*\(prefers-color-scheme:\s*light\)/);
  assert.match(html, /\.particle-canvas\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(html, /\.shell\s*\{[\s\S]*?position:\s*relative;[\s\S]*?z-index:\s*1;/);
});

test('扫描链路下拉所在顶栏叠层高于深度审计指标和粘性表头', () => {
  const headerBlock = html.match(/\n    header \{\n([\s\S]*?)\n    \}/);
  assert.ok(headerBlock, '应能提取顶栏 header 样式');
  assert.match(headerBlock[1], /position:\s*relative;/);
  assert.match(headerBlock[1], /overflow:\s*visible;/);
  const headerZ = Number(headerBlock[1].match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(headerZ) && headerZ >= 20, '顶栏须建立高于后续内容的层叠上下文，避免 backdrop-filter 把下拉关在内部');

  const menuZ = Number(html.match(/\.chain-dropdown-menu \{\n[\s\S]*?z-index:\s*(\d+)/)?.[1]);
  const thZ = Number(html.match(/\n    th \{\n[\s\S]*?z-index:\s*(\d+)/)?.[1]);
  const stickyCornerZ = Number(html.match(/th:first-child \{ z-index:\s*(\d+)/)?.[1]);
  const toastZ = Number(html.match(/\.toast \{\n[\s\S]*?z-index:\s*(\d+)/)?.[1]);
  assert.equal(thZ, 4);
  assert.equal(stickyCornerZ, 5);
  assert.ok(menuZ >= 100, '扫描链路菜单本身仍需高于顶栏内部控件');
  assert.ok(headerZ > stickyCornerZ, '顶栏整体须压过机器人/同源钱包等粘性表头');
  assert.ok(toastZ > headerZ, 'toast 仍须浮在顶栏之上');
});

test('多链切换与扫描选择渲染官方Web3Icons矢量图标', () => {
  assert.match(html, /const chainIcons =/);
  assert.match(html, /function chainIcon\(id\)/);
  for (const chain of ['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']) {
    assert.match(html, new RegExp('chain-icon-' + chain));
  }
  assert.match(html, /chainIcon\(chain\.id\)/);
});

