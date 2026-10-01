'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const config = require('../config');

test('extension saves a provider, discovers and imports models, rejects stale and fabricated selections', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-workflow-'));
  const file = path.join(directory, 'kilo.jsonc'); fs.writeFileSync(file, '{}');
  const messages = [], commands = new Map(); let receive, confirmed = true, fetched = 0;
  const vscode = {
    workspace: {getConfiguration: () => ({get: () => file})},
    Uri: {joinPath: (...parts) => parts.join('/')}, ViewColumn: {One: 1},
    commands: {registerCommand: (name, fn) => {commands.set(name, fn); return {dispose() {}};}},
    window: {
      createWebviewPanel: () => ({webview: {cspSource:'local',asWebviewUri: uri => uri,postMessage: message => messages.push(message),onDidReceiveMessage: fn => {receive=fn;return {dispose() {}};}},onDidDispose() {}}),
      showInformationMessage: async () => confirmed ? '保存' : undefined
    }
  };
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension.js'),'utf8'), {module,require: id => {
    if(id==='vscode')return vscode;
    if(id==='./picker')return {activate() {}};
    if(id==='./config')return config;
    if(id==='./providers')return {fetchModels: async (provider,id) => {fetched++;assert.equal(id,'example');assert.equal(provider.options.apiKey,'test-key');return [{id:'model-a',name:'Model A'}];}};
    return require(id);
  }});
  try {
    module.exports.activate({subscriptions:[],extensionUri:'extension'});commands.get('kiloModelManager.open')();
    await receive({type:'ready'});
    const revision=()=>messages.filter(message=>message.type==='data').at(-1).revision;
    const provider={action:'add',id:'example',name:'Example',npm:'@ai-sdk/openai-compatible',baseURL:'https://example.com/v1',apiKey:'test-key'};
    confirmed=false;await receive({type:'saveProvider',revision:revision(),command:provider});assert.deepEqual(config.read(file).value,{});
    confirmed=true;await receive({type:'saveProvider',revision:revision(),command:provider});
    assert.equal(config.read(file).value.provider.example.options.apiKey,'test-key');
    assert.ok(!JSON.stringify(messages).includes('test-key'));
    await receive({type:'fetchModels',revision:revision(),provider:'example'});assert.equal(fetched,1);
    await receive({type:'importModels',revision:revision(),provider:'example',ids:['fabricated']});
    assert.match(messages.at(-2).text,/未知模型/);
    vscode.window.showInformationMessage=async()=> '导入';
    await receive({type:'importModels',revision:revision(),provider:'example',ids:['model-a']});
    assert.deepEqual(config.read(file).value.provider.example.models['model-a'],{name:'Model A'});
    assert.ok(fs.readdirSync(directory).filter(name=>name.includes('.bak-')).length>=2);
    fs.appendFileSync(file,'\n');
    await receive({type:'fetchModels',revision:revision(),provider:'example'});
    assert.match(messages.at(-2).text,/配置已变化/);assert.equal(fetched,1);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
