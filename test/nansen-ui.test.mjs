import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function fixture() {
  const start=html.indexOf('// Nansen settings start'); const end=html.indexOf('// Nansen settings end');
  assert.ok(start>0 && end>start);
  const nodes={}; const calls=[];
  const context={ byId: id => nodes[id] ||= {value:'',checked:false,addEventListener(type,fn){this[type]=fn;}}, postLocal:async (url,body)=>{calls.push({url,body});return {saved:true,nansen:{enabled:body.enabled===true,configured:body.action!=='clear'}};}, refresh:async()=>{}, escapeHtml:v=>String(v).replaceAll('<','&lt;'), formatClock:String };
  vm.createContext(context);vm.runInContext(html.slice(start,end),context);
  return {context,nodes,calls};
}
test('Nansen settings use password without persistence and preserve dirty toggle during polls',async()=>{
  assert.match(html,/id="nansenKeyInput"[^>]*type="password"[^>]*maxlength="512"/);
  const {context,nodes,calls}=fixture();
  context.renderNansenSettings({nansen:{enabled:false,configured:true}});
  nodes.nansenEnabled.checked=true;nodes.nansenEnabled.change();
  context.renderNansenSettings({nansen:{enabled:false,configured:true}});
  assert.equal(nodes.nansenEnabled.checked,true);
  await context.saveNansenSettings({preventDefault(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{url:'/api/nansen-settings',body:{enabled:true}}]);
  nodes.nansenKeyInput.value='fresh-key';await context.saveNansenSettings({preventDefault(){}});
  assert.equal(nodes.nansenKeyInput.value,'');assert.equal(calls[1].body.apiKey,'fresh-key');
  assert.match(nodes.nansenSettingsStatus.textContent,/待.*复查.*验证/);
  await context.clearNansenSettings();assert.equal(calls[2].body.action,'clear');assert.equal(nodes.nansenEnabled.checked,false);
});
test('Nansen save errors keep editable values and busy state prevents duplicate writes',async()=>{
  const {context,nodes}=fixture();let release;
  context.postLocal=()=>new Promise((_,reject)=>{release=reject;});
  nodes.nansenKeyInput.value='fresh-key';
  const pending=context.saveNansenSettings({preventDefault(){}});
  assert.equal(nodes.nansenSave.disabled,true);
  await context.saveNansenSettings({preventDefault(){}});
  release(new Error('hidden-key'));await pending;
  assert.equal(nodes.nansenKeyInput.value,'fresh-key');assert.equal(nodes.nansenSave.disabled,false);
  assert.match(nodes.nansenSettingsStatus.textContent,/失败/);assert.doesNotMatch(nodes.nansenSettingsStatus.textContent,/hidden-key/);
});
test('Nansen evidence renders bounded escaped samples and unknowns, never a safety verdict',()=>{
  const {context}=fixture();
  const result=context.renderNansenReview({status:'OK',sampleCount:25,holders:Array.from({length:25},()=>({address:'<img>',label:'<script>',tokenAmount:null}))});
  assert.equal((result.match(/&lt;img>/g)||[]).length,20);assert.doesNotMatch(result,/<script>|<img>/);assert.match(result,/未知/);assert.match(result,/非完整/);assert.match(result,/不代表安全/);
});

test('Nansen corrupt local configuration is explained without raw errors',()=>{
  const {context,nodes}=fixture();
  context.renderNansenSettings({nansen:{enabled:false,configured:false,configurationError:'INVALID_LOCAL_CONFIG'}});
  assert.match(nodes.nansenSettingsStatus.textContent,/无法读取.*停用.*重新保存或清除/);
});
