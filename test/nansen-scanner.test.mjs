import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { Scanner } from '../src/scanner.mjs';
const address = '0x' + '1'.repeat(40);
function fixture({ enabled = true, fail = false, recheck = true } = {}) {
  const records = [], calls = [];
  const state = { value: { activeChain: 'robinhood', candidates: [], auditQueue: [], outcomes: [], events: [] }, save(next) { if(next) this.value=next; } };
  const watchPool = { capture() {}, snapshot: () => [], due: () => recheck ? [{chain:'robinhood',address,nextCheckAt:0}] : [], record: row=>records.push(row) };
  const gmgn = { keyEpoch: 0, metrics: {}, configured: async()=>true, discover: async()=>[],
    audit: async()=>({info:{price:{price:1},liquidity:10000},security:{},pool:{},holders:[],traders:[],candles:[],_meta:{complete:true}}) };
  const nansen = { snapshot:()=>({enabled,configured:true}), review: async input=>{calls.push(input); if(fail) throw new Error('raw-secret'); return {source:'NANSEN',status:'OK',checkedAt:Date.now(),sampled:true,sampleCount:1,hasMore:true,holders:[{address,valueUsd:1}]};} };
  const scanner = new Scanner({gmgn,nansen,watchPool,state,settings:config});
  return {scanner,nansen,gmgn,state,calls,records};
}
test('enabled Nansen enriches watch rechecks without changing primary verdict',async()=>{
  const f=fixture(); await f.scanner.cycle();
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].chain,'robinhood'); assert.equal(f.calls[0].address,address);
  assert.ok(f.calls[0].deadline>Date.now());
  assert.equal(f.records[0].nansen.status,'OK');
  assert.equal(f.records[0].status,'WAIT_RECHECK');
});
test('disabled Nansen makes no review call and leaves GMGN rechecks intact',async()=>{
  const f=fixture({enabled:false}); await f.scanner.cycle();
  assert.equal(f.calls.length,0); assert.equal(f.records.length,1);
});
test('Nansen error remains supplemental and never leaks provider exception',async()=>{
  const f=fixture({fail:true}); await f.scanner.cycle();
  assert.equal(f.records[0].nansen.status,'ERROR');
  assert.equal(f.records[0].status,'WAIT_RECHECK');
  assert.equal(JSON.stringify(f.state.value).includes('raw-secret'),false);
});
test('GMGN key change during optional Nansen read prevents outdated commit',async()=>{
  const f=fixture(); f.nansen.review=async()=>{f.gmgn.keyEpoch++;return {status:'OK'};};
  await f.scanner.cycle(); assert.equal(f.records.length,0);
});

test('first ordinary discovery audit does not call optional Nansen',async()=>{
  const f=fixture({recheck:false});
  f.gmgn.discover=async()=>[{address,market_cap:50000,liquidity:10000,creation_timestamp:Date.now()/1000-600,rug_ratio:.1,bundler_rate:.1,rat_trader_amount_rate:.1,is_wash_trading:false,is_honeypot:false}];
  await f.scanner.cycle(); assert.equal(f.records.length,1); assert.equal(f.calls.length,0);
});
test('a previously audited ordinary candidate invokes Nansen on its due recheck',async()=>{
  const f=fixture({recheck:false});
  f.gmgn.discover=async()=>[{address,market_cap:50000,liquidity:10000,creation_timestamp:Date.now()/1000-600,rug_ratio:.1,bundler_rate:.1,rat_trader_amount_rate:.1,is_wash_trading:false,is_honeypot:false}];
  f.state.value.auditQueue=[{address,firstSeenAt:Date.now()-100000,lastSeenAt:Date.now(),lastAuditedAt:Date.now()-100000,nextAuditAt:0,status:'WAIT_RECHECK'}];
  await f.scanner.cycle(); assert.equal(f.calls.length,1);
});

test('fresh Nansen evidence is reused on the next recheck without another review call',async()=>{
  const f=fixture();
  await f.scanner.cycle();
  assert.equal(f.calls.length,1);
  await f.scanner.cycle();
  assert.equal(f.calls.length,1);
  assert.equal(f.records.at(-1).nansen.status,'OK');
  assert.equal(f.records.at(-1).status,'WAIT_RECHECK');
});

test('one scan cycle spends at most one Nansen review even with multiple due rechecks',async()=>{
  const other='0x'+'2'.repeat(40);
  const row=addr=>({address:addr,market_cap:50000,liquidity:10000,creation_timestamp:Date.now()/1000-600,rug_ratio:.1,bundler_rate:.1,rat_trader_amount_rate:.1,is_wash_trading:false,is_honeypot:false});
  const f=fixture({recheck:false});
  f.gmgn.discover=async()=>[row(address),row(other)];
  f.state.value.auditQueue=[
    {address,firstSeenAt:1,lastSeenAt:1,lastAuditedAt:1,nextAuditAt:0,status:'WAIT_RECHECK',priorityBand:true,score:10},
    {address:other,firstSeenAt:1,lastSeenAt:1,lastAuditedAt:1,nextAuditAt:0,status:'WAIT_RECHECK',priorityBand:true,score:9}
  ];
  await f.scanner.cycle();
  assert.equal(f.calls.length,1);
  assert.equal(f.records.length,2);
  assert.equal(f.records.filter(item=>item.nansen?.status==='OK').length,1);
});
