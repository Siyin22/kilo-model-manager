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
