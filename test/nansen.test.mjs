import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NansenIntegration } from '../src/nansen.mjs';
const address = '0x1234567890123456789012345678901234567890';
const key = 'private-test-key-123';
const payload = (data = []) => ({ data, pagination: { page: 1, per_page: 20, is_last_page: true } });
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, client: new NansenIntegration(dir, { minIntervalMs: 0, cacheTtlMs: 0, ...options }) };
}
test('disabled default makes zero calls, settings persist privately and clear removes backup secrets', async t => {
  let calls = 0;
  const { dir, client } = setup(t, { fetchImpl: () => { calls++; } });
  assert.equal((await client.review({ chain: 'eth', address })).status, 'DISABLED');
  assert.equal(calls, 0);
  assert.throws(() => client.configure({ enabled: true }));
  for (const apiKey of ['short', 'with space key', 'abcdefg\n123', '中'.repeat(10)]) assert.throws(() => client.configure({ enabled: true, apiKey }));
  client.configure({ enabled: true, apiKey: key });
  client.configure({ enabled: false, apiKey: '' });
  assert.deepEqual(new NansenIntegration(dir).snapshot(), client.snapshot());
  assert.equal(client.snapshot().configured, true);
  assert.ok(!JSON.stringify(client.snapshot()).includes(key));
  assert.equal(fs.statSync(path.join(dir, 'nansen-settings.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'nansen-settings.json.bak'), JSON.stringify({ apiKey: key }));
  client.clear();
  for (const file of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, file), 'utf8').includes(key));
  assert.equal(new NansenIntegration(dir).snapshot().configured, false);
});
test('maps supported chains and returns only bounded normalized holder evidence', async t => {
  const requests = [];
  const { client } = setup(t, { fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    return Response.json(payload([{ address, address_label: key, token_amount: '12.2', ownership_percentage: null, balance_change_24h: '', value_usd: '15', extra: key }]));
  } });
  client.configure({ enabled: true, apiKey: key });
  for (const [chain, mapped] of Object.entries({ sol: 'solana', bsc: 'bnb', eth: 'ethereum', base: 'base', robinhood: 'robinhood' })) {
    const result = await client.review({ chain, address: chain === 'sol' ? '11111111111111111111111111111111' : address });
    assert.equal(result.status, 'OK'); assert.equal(result.sampleCount, 1); assert.equal(result.sampled, true);
    assert.deepEqual(result.holders[0], { address, label: null, tokenAmount: 12.2, ownershipPercentage: null, balanceChange24h: null, valueUsd: 15 });
    const req = requests.at(-1); const body = JSON.parse(req.body);
    assert.equal(body.chain, mapped); assert.equal(body.premium_labels, false); assert.equal(body.aggregate_by_entity, false);
    assert.equal(req.redirect, 'error'); assert.equal(req.headers.apikey, key);
  }
  assert.equal((await client.review({ chain: 'arc', address })).status, 'UNSUPPORTED');
  assert.equal((await client.review({ chain: 'eth', address: 'bad' })).status, 'ERROR');
  assert.equal(requests.length, 5);
});
test('empty, schema, provider errors and oversized payloads never leak provider messages', async t => {
  let response;
  const { client } = setup(t, { fetchImpl: async () => response });
  client.configure({ enabled: true, apiKey: key });
  for (const [body, status] of [[payload(), 'EMPTY'], [{ data: [] }, 'ERROR'], [payload([{}]), 'ERROR'], [{ data: 'bad', pagination: {} }, 'ERROR']]) {
    response = Response.json(body); assert.equal((await client.review({ chain: 'eth', address })).status, status);
  }
  response = new Response(key, { status: 500 });
  assert.ok(!JSON.stringify(await client.review({ chain: 'eth', address })).includes(key));
  response = new Response('x'.repeat(1048577));
  assert.equal((await client.review({ chain: 'eth', address })).errorCode, 'RESPONSE_TOO_LARGE');
});
test('configuration change cancels in-flight work even when fetch ignores abort', async t => {
  let release;
  const { client } = setup(t, { fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  client.configure({ enabled: true, apiKey: key });
  const pending = client.review({ chain: 'eth', address });
  await Promise.resolve(); client.configure({ enabled: false });
  assert.equal((await pending).status, 'CANCELLED');
  release(Response.json(payload([{ address }])));
});
test('hard timeout and exhausted deadline prevent unbounded calls', async t => {
  let calls = 0;
  const { client } = setup(t, { now: () => 100, timeoutMs: 10, fetchImpl: () => { calls++; return new Promise(() => {}); } });
  client.configure({ enabled: true, apiKey: key });
  assert.equal((await client.review({ chain: 'eth', address, deadline: 99 })).status, 'TIME_BUDGET');
  assert.equal(calls, 0);
  assert.equal((await client.review({ chain: 'eth', address })).status, 'TIME_BUDGET');
});
test('429 activates bounded shared cooldown across chains', async t => {
  let now = 100, calls = 0;
  const { client } = setup(t, { now: () => now, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '999999' } }); } });
  client.configure({ enabled: true, apiKey: key });
  assert.equal((await client.review({ chain: 'eth', address })).status, 'RATE_LIMITED');
  assert.equal((await client.review({ chain: 'base', address })).status, 'RATE_LIMITED'); assert.equal(calls, 1);
  now += 300001; await client.review({ chain: 'base', address }); assert.equal(calls, 2);
});
test('failed disk write leaves active configuration unchanged', t => {
  const { dir, client } = setup(t);
  client.configure({ enabled: true, apiKey: key });
  const before = client.snapshot();
  fs.renameSync(dir, `${dir}-moved`);
  fs.writeFileSync(dir, 'not a directory');
  try { assert.throws(() => client.configure({ enabled: false })); assert.deepEqual(client.snapshot(), before); }
  finally { fs.unlinkSync(dir); fs.renameSync(`${dir}-moved`, dir); }
});
test('streaming body cannot extend the hard deadline', async t => {
  const { client } = setup(t, { timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  client.configure({ enabled: true, apiKey: key });
  assert.equal((await client.review({ chain: 'eth', address })).status, 'TIME_BUDGET');
});
test('evidence normalization rejects unknown status and strips raw properties', async () => {
  const { nansenEvidence } = await import('../src/nansen.mjs');
  assert.equal(nansenEvidence(null), null);
  assert.equal(nansenEvidence({ status: 'SAFE' }), null);
  assert.equal(nansenEvidence({ status: 'ERROR', errorCode: key }), null);
  const evidence = nansenEvidence({ status: 'OK', raw: key, holders: Array.from({ length: 22 }, () => ({ address, label: 'sk-secret-key', raw: key, tokenAmount: null })) });
  assert.equal(evidence.sampleCount, 20); assert.equal(evidence.holders[0].tokenAmount, null); assert.equal(evidence.holders[0].label, null);
  assert.ok(!JSON.stringify(evidence).includes(key)); assert.ok(!JSON.stringify(evidence).includes('raw'));
});
test('authorization and credit errors briefly cool down calls across chains', async t => {
  let now = 0, calls = 0;
  const { client } = setup(t, { now: () => now, fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
  client.configure({ enabled: true, apiKey: key });
  assert.equal((await client.review({ chain: 'eth', address })).errorCode, 'HTTP_ERROR');
  assert.equal((await client.review({ chain: 'base', address })).errorCode, 'HTTP_ERROR');
  assert.equal(calls, 1);
  now = 60001; await client.review({ chain: 'base', address }); assert.equal(calls, 2);
});
test('credential reconfiguration does not reset provider rate-limit cooldown', async t => {
  let calls = 0;
  const { client } = setup(t, { fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } });
  client.configure({ enabled: true, apiKey: key });
  await client.review({ chain: 'eth', address });
  client.configure({ enabled: false }); client.configure({ enabled: true, apiKey: 'replacement-secret-key' });
  assert.equal((await client.review({ chain: 'eth', address })).status, 'RATE_LIMITED');
  assert.equal(calls, 1);
});
test('corrupt or unreadable optional configuration does not prevent construction or call provider', async t => {
  let calls = 0;
  const { dir } = setup(t);
  const file = path.join(dir, 'nansen-settings.json');
  const corrupt = '{broken config';
  fs.writeFileSync(file, corrupt);
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ enabled: true, apiKey: key }));
  const client = new NansenIntegration(dir, { fetchImpl: () => { calls++; } });
  assert.equal(client.snapshot().configurationError, 'INVALID_LOCAL_CONFIG');
  assert.equal(client.snapshot().enabled, false); assert.equal(client.snapshot().configured, false);
  assert.equal((await client.review({ chain: 'eth', address })).status, 'DISABLED'); assert.equal(calls, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  client.configure({ enabled: true, apiKey: key }); assert.equal(client.snapshot().configurationError, '');
  fs.unlinkSync(file); fs.mkdirSync(file);
  const unreadable = new NansenIntegration(dir);
  assert.equal(unreadable.snapshot().configurationError, 'INVALID_LOCAL_CONFIG');
  fs.rmdirSync(file); unreadable.clear(); assert.equal(unreadable.snapshot().configurationError, '');
});
test('successful holder evidence is reused within TTL and does not hit the provider again', async t => {
  let now = 1_000, calls = 0;
  const { client } = setup(t, {
    now: () => now, minIntervalMs: 60_000, cacheTtlMs: 30 * 60_000,
    fetchImpl: async () => { calls++; return Response.json(payload([{ address }])); }
  });
  client.configure({ enabled: true, apiKey: key });
  const first = await client.review({ chain: 'eth', address });
  now += 10_000;
  const second = await client.review({ chain: 'eth', address });
  assert.equal(first.status, 'OK');
  assert.equal(second.status, 'OK');
  assert.equal(second.checkedAt, first.checkedAt);
  assert.equal(calls, 1);
  now += 31 * 60_000;
  assert.equal((await client.review({ chain: 'eth', address })).status, 'OK');
  assert.equal(calls, 2);
});

test('live holder requests are spaced by the shared minimum interval across tokens', async t => {
  let now = 1_000, calls = 0;
  const other = '0x1234567890123456789012345678901234567891';
  const { client } = setup(t, {
    now: () => now, minIntervalMs: 5 * 60_000, cacheTtlMs: 0,
    fetchImpl: async () => { calls++; return Response.json(payload([{ address }])); }
  });
  client.configure({ enabled: true, apiKey: key });
  assert.equal((await client.review({ chain: 'eth', address })).status, 'OK');
  assert.equal((await client.review({ chain: 'base', address: other })).status, 'TIME_BUDGET');
  assert.equal(calls, 1);
  now += 5 * 60_000 + 1;
  assert.equal((await client.review({ chain: 'base', address: other })).status, 'OK');
  assert.equal(calls, 2);
});

test('invalid settings shapes remain disabled without automatic file replacement', t => {
  const { dir } = setup(t);
  const file = path.join(dir, 'nansen-settings.json');
  for (const settings of [null, [], {}, { enabled: 'yes', apiKey: key }, { enabled: true, apiKey: 'bad' }]) {
    const content = JSON.stringify(settings); fs.writeFileSync(file, content);
    const client = new NansenIntegration(dir);
    assert.equal(client.snapshot().configurationError, 'INVALID_LOCAL_CONFIG'); assert.equal(client.snapshot().enabled, false);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});
