'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../config');
const source = '\uFEFF{\r\n  // keep provider comment\r\n  "provider": {"local": {"options":{"apiKey":"DO-NOT-EXPOSE"}, "models": {"old": {"name":"Old","reasoning":true,"modalities":{"input":["text","image","audio"],"output":["text"]},"limit":{"context":123},"variants":{"custom":{"budget":19}}}}}},\r\n  "unknown": {"value":42},\r\n}\r\n';
const cmd = {action:'edit', provider:'local', id:'old', name:'Edited', reasoning:true, images:false, variants:{low:{reasoningEffort:'low'}}};
test('defaults disable old switches and all known variants without changing reasoning capability or model options', () => {
  const data = c.parse(source);
  const model = data.provider.local.models.old;
  model.variants = {on:{reasoningEffort:'high'},off:{reasoningEffort:'none'},custom:{thinking:{type:'enabled'}}};
  model.options = {temperature:0.8};
  const result = c.parse(c.update(JSON.stringify(data), {...cmd,variants:{}})).provider.local.models.old;
  assert.ok(Object.values(result.variants).every(v => v.disabled === true));
  assert.equal(result.reasoning,true);
  assert.deepEqual(result.options,{temperature:0.8});
  assert.equal(result.variants.on.disabled,true);
  assert.equal(result.variants.off.disabled,true);
});
test('edit preserves unrelated settings, comments, BOM, newline, modalities and unknown fields', () => {
  const text = c.update(source, cmd), result = c.parse(text);
  assert.ok(text.startsWith('\uFEFF')); assert.ok(text.includes('// keep provider comment'));
  assert.ok(text.includes('\r\n')); assert.deepEqual(result.unknown, {value:42});
  assert.equal(result.provider.local.options.apiKey, 'DO-NOT-EXPOSE');
  const m = result.provider.local.models.old;
  assert.deepEqual(m.limit,{context:123}); assert.deepEqual(m.modalities,{input:['text','audio'],output:['text']});
  assert.deepEqual(m.variants.low,{reasoningEffort:'low'});
  assert.deepEqual(m.variants.custom,{budget:19,disabled:true});
  assert.equal(m.variants.high.disabled,true);
});
test('add/delete model with slash ID and reject duplicate creation', () => {
  const add = {...cmd, action:'add',id:'org/new', images:true};
  const text = c.update(source, add);
  assert.deepEqual(c.parse(text).provider.local.models['org/new'].modalities.input,['text','image']);
  assert.throws(()=>c.update(text,add),/已存在/);
  const deleted = c.update(text,{action:'delete',provider:'local',id:'org/new'});
  assert.deepEqual(c.parse(deleted),c.parse(source));
});
test('webview payload excludes provider credentials and unrelated config', () => {
  const safe = JSON.stringify(c.safeModels(c.parse(source)));
  assert.ok(!safe.includes('DO-NOT-EXPOSE')); assert.ok(!safe.includes('apiKey'));
});
test('invalid JSONC, duplicate keys, malformed variants and unknown actions rejected', () => {
  for (const text of ['{"a":1,"a":2}', '{broken}', '[]']) assert.throws(()=>c.parse(text));
  assert.throws(()=>c.update(source,{...cmd,variants:{high:5}}));
  assert.throws(()=>c.update(source,{...cmd,action:'anything'}));
});
test('commit backs up exact original, restore and concurrent edits are safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'kilo-manager-test-'));
  try {
    const file = path.join(dir,'kilo.jsonc'); fs.writeFileSync(file,source);
    const before = c.read(file); const text = c.update(before.text,cmd);
    const backup = c.commit(file,before.hash,text);
    assert.equal(fs.readFileSync(backup,'utf8'),source);
    assert.equal(fs.readFileSync(file,'utf8'),text);
    assert.throws(()=>c.commit(file,before.hash,source),/其他程序/);
    c.commit(file,c.read(file).hash,fs.readFileSync(backup,'utf8'));
    assert.equal(fs.readFileSync(file,'utf8'),source);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('switch mode stores enabled defaults and only a disabled-thinking variant; graded mode clears switch controls', () => {
  const data = c.parse(source);
  data.provider.local.models.old.options = {temperature:0.4, thinking:{type:'adaptive'}};
  const switchCommand = {...cmd, reasoningMode:'switch', defaultOptions:{thinking:{type:'enabled'}}, variants:{'关闭':{thinking:{type:'disabled'}}}};
  const saved = c.update(JSON.stringify(data),switchCommand);
  const model=c.parse(saved).provider.local.models.old;
  assert.deepEqual(model.options,{temperature:0.4,thinking:{type:'enabled'}});
  assert.deepEqual(Object.keys(model.variants).filter(key=>!model.variants[key].disabled),['关闭']);
  assert.deepEqual(model.variants['关闭'],{thinking:{type:'disabled'}});
  const graded=c.parse(c.update(saved,{...cmd,reasoningMode:'graded',defaultOptions:{}})).provider.local.models.old;
  assert.deepEqual(graded.options,{temperature:0.4}); assert.equal(graded.variants['关闭'].disabled,true);
  assert.throws(()=>c.update(saved,{...switchCommand,defaultOptions:{}}),/开启参数/);
});

test('provider creation/edit preserves JSONC, credentials on blank input, existing models and other fields', () => {
  const provider={action:'add',id:'example',name:'Example',npm:'@ai-sdk/openai-compatible',baseURL:'https://example.com/v1/',apiKey:'TEST-KEY'};
  let text=c.updateProvider(source,provider);
  assert.ok(text.includes('// keep provider comment'));
  assert.deepEqual(c.parse(text).provider.example.models,{});
  assert.equal(c.parse(text).provider.example.options.baseURL,'https://example.com/v1');
  text=c.importModels(text,'example',[{id:'org/model',name:'Model'}]);
  text=c.updateProvider(text,{...provider,action:'edit',name:'Updated',apiKey:''});
  assert.equal(c.parse(text).provider.example.options.apiKey,'TEST-KEY');
  assert.equal(c.parse(text).provider.example.models['org/model'].name,'Model');
  assert.ok(!JSON.stringify(c.safeModels(c.parse(text))).includes('TEST-KEY'));
  assert.throws(()=>c.updateProvider(text,provider),/已存在/);
  assert.throws(()=>c.updateProvider('{}',{...provider,id:'__proto__'}),/ID/);
  assert.throws(()=>c.updateProvider('{}',{...provider,baseURL:'https://key:secret@example.com/v1'}),/地址/);
});

test('model import does not overwrite existing capabilities and supports a provider without models', () => {
  const next=c.importModels(source,'local',[{id:'old',name:'Overwrite'},{id:'new',name:'New'}]);
  assert.deepEqual(c.parse(next).provider.local.models.old,c.parse(source).provider.local.models.old);
  assert.deepEqual(c.parse(next).provider.local.models.new,{name:'New'});
  assert.equal(c.parse(c.importModels('{"provider":{"empty":{}}}','empty',[{id:'first'}])).provider.empty.models.first.name,'first');
  assert.equal(c.safeModels({provider:{empty:{}}})[0].models.length,0);
});
