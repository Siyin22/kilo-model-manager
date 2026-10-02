'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const patcher = require('../patcher');

// Minimal executable-shaped source with the same patch boundaries as Kilo.
// A top-level throw verifies that compatibility checking never executes bundles.
const source = `throw Error('bundle must not execute');
var gateway="kilo",group="most-used";
function selector(e){
 const t=()=>[],n=()=>[],o={},items=[];
 const list=()=>{if(e.models)return e.models;let connected=t();return n().filter(item=>!e.includeAutoSmall&&isSmall(item)?!1:item.providerID===gateway||connected.includes(item.providerID))};
 !search()&&o&&items.push(...rank(list(),o.modelUsageHistory(),favorites()));
 return [list,"model.group.mostUsed"];
}
function bridge(e){let t=new Map,n=e.onMessage(o=>{const s=t.get(o.requestId);if(s){o.type==="providerActionError"&&s.onError?.(o)}});function r(o,s={}){let l=crypto.randomUUID();return t.set(l,s),e.postMessage({...o,requestId:l}),l}return r;}
function variants(e){return e.variants.length===0&&!e.value?[]:e.allowClear?[void 0,...e.variants]:e.variants;}
`;
const names = ['webview.js', 'agent-manager.js'];
const options = {hideGateway: true, disableMostUsed: true, fixNativeSave: true};
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-compatibility-'));
  const extension = path.join(dir, 'extension'), storage = path.join(dir, 'storage');
  fs.mkdirSync(path.join(extension, 'dist'), {recursive: true});
  const manifest = path.join(extension, 'package.json');
  fs.writeFileSync(manifest, '{"version":"99.0.0"}');
  const targets = names.map(name => path.join(extension, 'dist', name));
  for (const target of targets) fs.writeFileSync(target, source);
  try { fn({extension, storage, manifest, targets}); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('structural baseline supports all option combinations, repeated application and exact restoration', () => fixture(({extension, storage, targets}) => {
  const first = patcher.inspect(extension, storage);
  assert.equal(first.compatibility, 'structural');
  assert.equal(fs.existsSync(storage), false, 'inspection must not create a baseline');
  for (const hideGateway of [true, false]) for (const disableMostUsed of [true, false]) for (const fixNativeSave of [true, false]) {
    const setting = {hideGateway, disableMostUsed, fixNativeSave};
    patcher.apply(extension, storage, setting);
    const state = patcher.inspect(extension, storage);
    assert.ok(state.files.every(file => JSON.stringify(file.options) === JSON.stringify(setting)));
    assert.equal(patcher.apply(extension, storage, setting).changed, false);
  }
  for (const target of targets) assert.equal(fs.readFileSync(target, 'utf8'), source);
  const receipt = JSON.parse(fs.readFileSync(first.receiptPath, 'utf8'));
  assert.deepEqual(receipt.hashes, Object.fromEntries(names.map(name => [name, patcher.hash(source)])));
}));

for (const [reason, change] of [
  ['duplicate selector', s => s + 'var duplicate="most-used";'],
  ['changed model source', s => s.replace('if(e.models)return e.models;', 'if(e.models)return [...e.models];')],
  ['changed usage group', s => s.replace('o.modelUsageHistory()', 'o.newUsageHistory()')],
  ['changed provider bridge', s => s.replace('e.postMessage({...o,requestId:l})', 'e.send({...o,requestId:l})')],
  ['changed default selector', s => s.replace('e.variants.length===0', 'e.variants.length<1')],
  ['syntax error', s => s + '\nfunction {'],
  ['existing local patch', s => s + '\n/* local: foreign patch */']
]) test(`first-time structural check rejects ${reason} without touching either bundle`, () => fixture(({extension, storage, targets}) => {
  fs.writeFileSync(targets[1], change(source));
  const before = targets.map(file => fs.readFileSync(file, 'utf8'));
  assert.throws(() => patcher.apply(extension, storage, options));
  assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.deepEqual(fs.readdirSync(storage), [], 'no partial baseline or lock remains');
}));

for (const mode of ['receipt', 'identity', 'backup', 'missing-backup', 'missing-receipt', 'foreign-edit']) {
  test(`persisted baseline rejects ${mode} damage without replacing files`, () => fixture(({extension, storage, targets}) => {
    patcher.apply(extension, storage, options);
    const state = patcher.inspect(extension, storage);
    if (mode === 'receipt') fs.writeFileSync(state.receiptPath, '{broken');
    if (mode === 'identity') {
      const receipt = JSON.parse(fs.readFileSync(state.receiptPath, 'utf8'));
      receipt.version = '88.0.0';
      fs.writeFileSync(state.receiptPath, JSON.stringify(receipt));
    }
    if (mode === 'backup') fs.appendFileSync(state.files[1].backup, '//corrupt');
    if (mode === 'missing-backup') fs.unlinkSync(state.files[1].backup);
    if (mode === 'missing-receipt') fs.unlinkSync(state.receiptPath);
    if (mode === 'foreign-edit') fs.appendFileSync(targets[1], '//external edit');
    const before = targets.map(file => fs.readFileSync(file, 'utf8'));
    assert.throws(() => patcher.apply(extension, storage, {}));
    assert.deepEqual(targets.map(file => fs.readFileSync(file, 'utf8')), before);
    assert.equal(fs.existsSync(path.join(storage, 'patch.lock')), false);
  }));
}

test('same installation path after upgrade gets its own baseline; reinstall of the same version still works', () => fixture(({extension, storage, manifest, targets}) => {
  patcher.apply(extension, storage, options);
  const old = patcher.inspect(extension, storage);
  for (const file of targets) fs.writeFileSync(file, source);
  assert.equal(patcher.apply(extension, storage, options).changed, true);
  fs.writeFileSync(manifest, '{"version":"99.0.1"}');
  const updated = source + '\n// unrelated upstream update';
  for (const file of targets) fs.writeFileSync(file, updated);
  patcher.apply(extension, storage, options);
  const next = patcher.inspect(extension, storage);
  assert.notEqual(next.directory, old.directory);
  patcher.apply(extension, storage, {});
  for (const file of targets) assert.equal(fs.readFileSync(file, 'utf8'), updated);
  assert.equal(fs.readFileSync(old.files[0].backup, 'utf8'), source);
}));

test('second-bundle write failure rolls back and leaves a usable baseline for retry', () => fixture(({extension, storage, targets}) => {
  const write = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = function(file, ...args) {
    if (file === targets[1] && !failed) { failed = true; throw Error('injected write failure'); }
    return write.call(this, file, ...args);
  };
  try { assert.throws(() => patcher.apply(extension, storage, options), /injected/); }
  finally { fs.writeFileSync = write; }
  for (const file of targets) assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.equal(patcher.apply(extension, storage, options).changed, true);
}));

test('a later verified signature adopts a previously structural baseline', () => fixture(({extension, storage, targets}) => {
  patcher.apply(extension, storage, options);
  const signatures = require('../signatures.json');
  signatures['99.0.0'] = Object.fromEntries(names.map(name => [name, patcher.hash(source)]));
  try {
    assert.equal(patcher.apply(extension, storage, options).compatibility, 'verified');
    patcher.apply(extension, storage, {});
    for (const file of targets) assert.equal(fs.readFileSync(file, 'utf8'), source);
  } finally { delete signatures['99.0.0']; }
}));
