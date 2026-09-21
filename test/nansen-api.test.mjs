import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../src/server.mjs';
function fixture() {
  const calls = [];
  const review = { source: 'nansen', status: 'OK', sampleCount: 1, sampled: true, hasMore: true, apiKey: 'hidden-key', raw: 'hidden-key', holders: [{ address: '0x1111111111111111111111111111111111111111', label: '<script>', tokenAmount: null, apiKey: 'hidden-key' }] };
  const nansen = { snapshot: () => ({ enabled: true, configured: true, supportedChains: ['sol','robinhood'], apiKey: 'hidden-key' }), configure: value => calls.push(value), clear: () => calls.push('clear') };
  const server = createServer({ state: { value: { activeChain: 'robinhood', candidates: [{ nansen: review }] } }, settings: { port: 3791, publicDir: path.resolve('public') }, nansen, watchPool: { snapshot: () => [{ chain: 'robinhood', latest: { nansen: review }, history: [{ nansen: review }] }] } });
  return { server, calls, nansen };
}
async function dispatch(server, body, { origin = 'http://127.0.0.1:3791', url = '/api/nansen-settings', method = 'POST', contentType = 'application/json' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3791', origin, 'content-type': contentType } });
  return new Promise((resolve,reject) => { let code; Promise.resolve(server.listeners('request')[0](req, { setHeader() {}, writeHead(v) { code=v; }, end(v) { resolve({ code, body: JSON.parse(v) }); } })).catch(reject); });
}
test('Nansen settings require same-origin, bounded JSON and strict input', async () => {
  const {server,calls}=fixture();
  for(const origin of ['', 'https://evil.example','http://localhost:3791']) assert.equal((await dispatch(server,{enabled:true},{origin})).code,403);
  for(const body of [null,[],{}, {enabled:'true'}, {enabled:true,apiKey:123}, {enabled:true,apiKey:'x'.repeat(513)}, {enabled:true,extra:1}, {action:'clear',enabled:false}]) assert.equal((await dispatch(server,body)).code,400);
  assert.equal((await dispatch(server,{enabled:true},{contentType:'text/plain'})).code,415);
  assert.equal((await dispatch(server,{enabled:true,apiKey:'x'.repeat(2048)})).code,413);
  assert.equal(calls.length,0);
});
test('Nansen saves optional key, toggles and clears without exposing credentials', async () => {
  const {server,calls,nansen}=fixture();
  for(const body of [{enabled:true,apiKey:'test-key'},{enabled:false},{action:'clear'}]) assert.equal((await dispatch(server,body)).code,200);
  assert.deepEqual(calls,[{enabled:true,apiKey:'test-key'},{enabled:false},'clear']);
  nansen.configure=()=>{throw Object.assign(new Error('hidden-key'),{statusCode:400});};
  const response=await dispatch(server,{enabled:true}); assert.equal(response.code,400); assert.doesNotMatch(JSON.stringify(response),/hidden-key/);
});
test('Nansen status/export expose only settings and normalized evidence', async () => {
  const {server}=fixture();
  for(const url of ['/api/status','/api/export']) {
    const {body}=await dispatch(server,undefined,{method:'GET',url});
    assert.deepEqual(body.nansen,{enabled:true,configured:true,configurationError:'',supportedChains:['sol','robinhood']});
    assert.equal(body.watchPool[0].latest.nansen.holders[0].tokenAmount,null);
    assert.equal(body.candidates[0].nansen.sampleCount,1);
    assert.doesNotMatch(JSON.stringify(body),/hidden-key|apiKey|"raw"/);
  }
});

test('Nansen configuration error exposes only the safe code', async () => {
  const {server,nansen}=fixture();
  nansen.snapshot=()=>({enabled:false,configured:false,supportedChains:[],configurationError:'INVALID_LOCAL_CONFIG',error:'hidden-key'});
  const {body}=await dispatch(server,undefined,{method:'GET',url:'/api/status'});
  assert.equal(body.nansen.configurationError,'INVALID_LOCAL_CONFIG');
  assert.doesNotMatch(JSON.stringify(body),/hidden-key/);
});
