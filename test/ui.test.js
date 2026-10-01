'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname, '..');
function setup() {
  const sandbox = {require: id => id === 'vscode' ? {Uri: {joinPath: (...v) => v.join('/')}} : id === './config' ? require('../config') : require(id), module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'extension.js'),'utf8') + '\nmodule.exports.testHtml=html;', sandbox);
  const html = sandbox.module.exports.testHtml({cspSource:'local',asWebviewUri:x=>x},'extension');
  const dom = new JSDOM(html,{runScripts:'outside-only'}), messages=[];
  dom.window.acquireVsCodeApi=()=>({postMessage: m=>messages.push(JSON.parse(JSON.stringify(m)))});
  dom.window.eval(fs.readFileSync(path.join(root,'media/reasoning.js'),'utf8'));
  dom.window.eval(fs.readFileSync(path.join(root,'media/app.js'),'utf8'));
  const send = m=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{data:m}));
  const data={type:'data',file:'test.jsonc',revision:'a',providers:[{id:'p',name:'Provider',models:[{id:'existing',name:'Existing',reasoning:true,images:false,variants:{low:{reasoningEffort:'low'},hidden:{disabled:true}}}]}]};
  send(data);send({type:'done'});
  return {dom,messages,send,data,$:id=>dom.window.document.getElementById(id)};
}
test('actual page adds a model, uses defaults without reasoning overrides, sends plain data and handles cancellation/error',()=>{
  const {dom,messages,send,$}=setup();
  try {
    $('add').click(); $('modelId').value='grok-4.7';$('modelName').value='Grok 4.7';
    $('level-high').click();
    assert.equal($('level-high').checked,true);
    assert.deepEqual(JSON.parse($('variants').value),{high:{reasoningEffort:'high'}});
    $('level-high').click();
    assert.deepEqual(JSON.parse($('variants').value),{});
    assert.equal($('level-none'),null);
    $('defaults').click();
    assert.match($('preview').textContent,/grok-4.7/);
    $('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    const request=messages.at(-1);
    assert.equal(request.type,'save');assert.equal(request.command.action,'add');
    assert.deepEqual(request.command.variants,{});
    assert.equal(request.command.reasoning,true);
    assert.equal($('save').disabled,true);
    send({type:'error',text:'配置冲突'});send({type:'done'});
    assert.equal($('save').disabled,false);assert.equal($('status').textContent,'配置冲突');
    assert.equal($('modelId').value,'grok-4.7');
    $('variants').value='{broken';
    const count=messages.length;
    $('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    assert.equal(messages.length,count);assert.equal($('save').disabled,false);
  }finally{dom.window.close();}
});

test('switch mode exposes only native default and a real off variant, then switches back to graded', () => {
  const {dom,messages,send,$}=setup();
  try {
    $('add').click(); $('modelId').value='switch-model'; $('modelName').value='Switch';
    $('reasoningMode').value='switch'; $('reasoningMode').dispatchEvent(new dom.window.Event('change'));
    assert.equal($('gradedFields').hidden,true);
    $('thinkingProtocol').value='thinking'; $('applyThinkingTemplate').click();
    $('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    let command=messages.at(-1).command;
    assert.deepEqual(command.defaultOptions,{thinking:{type:'enabled'}});
    assert.deepEqual(command.variants,{'关闭':{thinking:{type:'disabled'}}});
    assert.equal(command.reasoningMode,'switch');
    send({type:'done'});
    $('reasoningMode').value='graded'; $('reasoningMode').dispatchEvent(new dom.window.Event('change'));
    $('level-low').click(); $('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    command=messages.at(-1).command;
    assert.deepEqual(command.defaultOptions,{});
    assert.deepEqual(command.variants,{low:{reasoningEffort:'low'}});
  } finally {dom.window.close();}
});

test('provider form works with no configured providers and keeps typed credentials out of refresh payload', () => {
  const {dom,messages,send,$}=setup();
  try {
    send({type:'data',providers:[],file:'test',revision:'b'}); send({type:'done'});
    $('addProvider').click(); assert.equal($('providerForm').hidden,false);
    $('providerId').value='example'; $('providerName').value='Example'; $('providerURL').value='https://example.com/v1'; $('providerKey').value='new-test-key';
    $('providerForm').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    const request=messages.at(-1);
    assert.equal(request.type,'saveProvider'); assert.equal(request.command.apiKey,'new-test-key');
    send({type:'data',providers:[{id:'example',name:'Example',baseURL:'https://example.com/v1',models:[]}],selectedProvider:'example',revision:'c'}); send({type:'done'});
    assert.equal($('provider').value,'example'); assert.equal($('providerKey').value,'');
    $('editProvider').click(); assert.equal($('providerId').readOnly,true); assert.equal($('providerKey').value,'');
  } finally {dom.window.close();}
});

test('model discovery safely renders names, skips existing models and imports only selected IDs', () => {
  const {dom,messages,send,$}=setup();
  try {
    $('fetchModels').click(); assert.equal(messages.at(-1).type,'fetchModels');
    send({type:'catalog',provider:'p',models:[{id:'existing',name:'Existing'},{id:'new',name:'<img src=x onerror=alert(1)>'}]}); send({type:'done'});
    assert.equal($('catalogList').querySelector('img'),null);
    assert.equal($('catalogList').querySelector('input').disabled,true);
    $('selectCatalog').click(); $('importModels').click();
    assert.deepEqual(messages.at(-1),{type:'importModels',revision:'a',provider:'p',ids:['new']});
  } finally {dom.window.close();}
});

test('toolbox opens grouping settings without discarding unsaved model edits', () => {
  const {dom,messages,send,$}=setup();
  try {
    $('add').click(); $('modelId').value='unsaved'; $('modelName').value='Unsaved';
    $('pickerSettings').click();
    assert.deepEqual(messages.at(-1), {type:'pickerSettings'});
    send({type:'done'});
    assert.equal($('modelId').value,'unsaved');
    assert.equal($('pickerSettings').disabled,false);
  } finally { dom.window.close(); }
});
test('existing model ID read-only; custom settings survive UI; successful refresh selects added model',()=>{
  const {dom,messages,send,data,$}=setup();
  try{
    dom.window.document.querySelector('.model').click();
    assert.equal($('modelId').readOnly,true);
    $('variants').value='{"custom":{"thinking":{"type":"enabled"}}}';
    $('variants').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    $('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    assert.deepEqual(messages.at(-1).command.variants,{custom:{thinking:{type:'enabled'}}});
    send({type:'done'}); // cancelled modal leaves form usable and unsaved
    assert.equal($('save').disabled,false);
    send(data);send({type:'done'});$('add').click();$('modelId').value='new';
    const next=structuredClone(data);next.providers[0].models.push({id:'new',name:'New',reasoning:true,images:false,variants:{}});
    send(next);send({type:'done'});
    assert.equal($('modelId').value,'new');assert.equal($('modelId').readOnly,true);
  }finally{dom.window.close();}
});
