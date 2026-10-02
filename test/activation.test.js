'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(legacy = false, autoApply = false) {
  const commands = new Map(), warnings = [], calls = [], executed = [], logs = [];
  let extensionChanged;
  const disposable = {dispose() {}};
  const values = {autoApply, hideGateway: false, disableMostUsed: true, fixNativeSave: true};
  const vscode = {
    window: {
      createOutputChannel: () => ({appendLine: line => logs.push(line), ...disposable}),
      showWarningMessage: text => warnings.push(text)
    },
    commands: {
      registerCommand(id, fn) { assert.ok(!commands.has(id)); commands.set(id, fn); return disposable; },
      executeCommand: (...args) => executed.push(args)
    },
    extensions: {
      getExtension: id => id === 'local-tools.kilo-picker-helper' ? (legacy ? {} : undefined) : {extensionPath: 'kilo'},
      onDidChange: listener => { extensionChanged = listener; return disposable; }
    },
    workspace: {
      getConfiguration: () => ({get: (key, fallback) => values[key] ?? fallback}),
      onDidChangeConfiguration: () => disposable
    }
  };
  function load(name) {
    const module = {exports: {}};
    const sandbox = {module, require: id => id === 'vscode' ? vscode : id === './picker' ? load('picker.js') :
      id === './patcher' ? {apply: (...args) => {calls.push(args); return {changed: false, version: '99.0.0', compatibility: 'structural'};}} :
      id === './config' ? require('../config') : require(id)};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), sandbox);
    return module.exports;
  }
  load('extension.js').activate({subscriptions: [], globalStorageUri: {fsPath: 'toolbox-storage'}});
  return {commands, warnings, calls, executed, logs, extensionChanged: () => extensionChanged()};
}

test('combined extension registers both feature sets and honors existing patch settings', async () => {
  const state = setup(false, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.commands.size, 5);
  assert.ok(state.commands.has('kiloModelManager.open'));
  state.commands.get('kiloPicker.settings')();
  assert.deepEqual(state.executed[0], ['workbench.action.openSettings', '@ext:local-tools.kilo-model-manager-local']);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0][1], 'toolbox-storage');
  assert.deepEqual(JSON.parse(JSON.stringify(state.calls[0][2])), {hideGateway: false, disableMostUsed: true, fixNativeSave: true});
});

test('automatic application handles extension updates and logs structural compatibility', async () => {
  const state = setup(false, true);
  await new Promise(resolve => setImmediate(resolve));
  state.extensionChanged();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls.length, 2);
  assert.equal(state.warnings.length, 0);
  assert.ok(state.logs.some(line => line.includes('结构检查通过')));
  const manual = setup(false, false);
  manual.extensionChanged();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manual.calls.length, 0);
});

test('enabled legacy helper prevents duplicate commands and writes, but model management remains available', () => {
  const state = setup(true, true);
  assert.deepEqual([...state.commands.keys()], ['kiloModelManager.open']);
  assert.equal(state.calls.length, 0);
  assert.equal(state.warnings.length, 1);
});
