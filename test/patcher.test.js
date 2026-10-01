const {test: nodeTest} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const patcher = require('../patcher');
const real = process.env.KILO_TEST_DIST || path.join(os.homedir(), '.vscode/extensions/kilocode.kilo-code-7.8.1-win32-x64/dist');
const names = ['webview.js', 'agent-manager.js'];
const signatures = require('../signatures.json')['7.8.1'];
const originals = {};
if (fs.existsSync(real)) for (const name of names) {
  const candidates = [name, ...fs.readdirSync(real).filter(n => n.startsWith(name + '.bak-model-picker-'))];
  for (const candidate of candidates) {
    const file = path.join(real, candidate);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (patcher.hash(source) === signatures[name]) { originals[name] = source; break; }
  }
}
const available = names.every(name => originals[name]);
const test = (name, fn) => nodeTest(name, {skip: available ? false : 'Set KILO_TEST_DIST to verified Kilo 7.8.1 original dist files.'}, fn);
nodeTest('unsupported selector fails without executing its code', () => {
  assert.throws(() => patcher.transform('throw Error("must not run");', {}), /结构不兼容/);
});
function fixture(fn) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-picker-test-'));
  const extension = path.join(temporary, 'extension');
  const storage = path.join(temporary, 'storage');
  fs.mkdirSync(path.join(extension, 'dist'), {recursive: true});
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({version: '7.8.1'}));
  for (const name of names) fs.writeFileSync(path.join(extension, 'dist', name), originals[name]);
  try { fn(extension, storage); } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
}
test('all eight independent settings, repeat apply, exact restore', () => fixture((extension, storage) => {
  for (const hideGateway of [true, false]) for (const disableMostUsed of [true, false]) for (const fixNativeSave of [true, false]) {
    const options = {hideGateway, disableMostUsed, fixNativeSave};
    patcher.apply(extension, storage, options);
    assert.ok(patcher.inspect(extension, storage).files.every(f => JSON.stringify(f.options) === JSON.stringify(options)));
    assert.equal(patcher.apply(extension, storage, options).changed, false);
  }
  for (const name of names) assert.equal(fs.readFileSync(path.join(extension, 'dist', name), 'utf8'), originals[name]);
}));
test('legacy Python patch adoption', () => fixture((extension, storage) => {
  for (const name of names) {
    const file = path.join(extension, 'dist', name);
    fs.writeFileSync(file + '.bak-model-picker-legacy', originals[name]);
    fs.writeFileSync(file, patcher.transform(originals[name], {hideGateway: true, disableMostUsed: true}));
  }
  assert.equal(patcher.apply(extension, storage, {hideGateway: true, disableMostUsed: true}).changed, false);
  patcher.apply(extension, storage, {hideGateway: false, disableMostUsed: false});
  for (const name of names) assert.equal(fs.readFileSync(path.join(extension, 'dist', name), 'utf8'), originals[name]);
}));

test('upgrades the 0.2.0 save fix and keeps native default selectable with zero variants', () => fixture((extension, storage) => {
  const options={hideGateway:true,disableMostUsed:true,fixNativeSave:true};
  patcher.apply(extension,storage,{...options,legacyNativeSave:true});
  assert.equal(patcher.apply(extension,storage,options).changed,true);
  for(const file of patcher.inspect(extension,storage).files) {
    assert.ok(file.current.includes('/* local: keep native default choice */'));
    const expression=file.current.match(/\/\* local: keep native default choice \*\/([^,;]+\?\[void 0,\.\.\.e\.variants\]:e\.variants)/)[1];
    const choose=vm.runInNewContext('(e)=>'+expression);
    assert.deepEqual(Array.from(choose({variants:[],allowClear:true})),[undefined]);
    assert.deepEqual(Array.from(choose({variants:['关闭'],allowClear:true})),[undefined,'关闭']);
    assert.deepEqual(Array.from(choose({variants:['low','high'],allowClear:true})),[undefined,'low','high']);
  }
}));

test('upgrade from grouping-only patch preserves options and can fully restore', () => fixture((extension, storage) => {
  patcher.apply(extension, storage, {hideGateway: true, disableMostUsed: true});
  assert.equal(patcher.apply(extension, storage, {hideGateway: true, disableMostUsed: true, fixNativeSave: true}).changed, true);
  assert.ok(patcher.inspect(extension, storage).files.every(f => f.options.fixNativeSave));
  patcher.apply(extension, storage, {hideGateway: true, disableMostUsed: false, fixNativeSave: true});
  assert.ok(patcher.inspect(extension, storage).files.every(f => f.options.fixNativeSave && !f.options.disableMostUsed));
  patcher.apply(extension, storage, {});
  for (const name of names) assert.equal(fs.readFileSync(path.join(extension, 'dist', name), 'utf8'), originals[name]);
}));

function bridge(source, postMessage) {
  const anchor = 'let t=new Map,n=e.onMessage(o=>{if(!("requestId"in o))return;';
  const at = source.indexOf(anchor);
  assert.ok(at >= 0);
  const start = source.lastIndexOf('function ', at);
  const tail = 'return{clear:a,send:r,dispose:i}}';
  const end = source.indexOf(tail, at) + tail.length;
  const code = source.slice(start, end);
  assert.ok(code.includes('providerOAuthReady'));
  let receive, disposed = false;
  const create = vm.runInNewContext('(' + code + ')', {crypto: {randomUUID}});
  const actions = create({postMessage, onMessage: listener => {
    receive = listener;
    return () => { disposed = true; };
  }});
  return {actions, receive: message => receive(message), disposed: () => disposed};
}

function proxyTree(value) {
  return value && typeof value === 'object' ? new Proxy(value, {
    get(target, key) { return proxyTree(Reflect.get(target, key)); }
  }) : value;
}

test('adopts verified legacy storage backups and restores without the old extension', () => fixture((extension, storage) => {
  const legacy = path.join(path.dirname(storage), 'local-tools.kilo-picker-helper');
  const options = {hideGateway: true, disableMostUsed: true, fixNativeSave: true};
  patcher.apply(extension, legacy, options);
  assert.equal(patcher.apply(extension, storage, options).changed, false);
  const migrated = patcher.inspect(extension, storage);
  for (const file of migrated.files) assert.equal(fs.readFileSync(file.backup, 'utf8'), file.original);
  fs.rmSync(legacy, {recursive: true});
  patcher.apply(extension, storage, {});
  for (const name of names) assert.equal(fs.readFileSync(path.join(extension, 'dist', name), 'utf8'), originals[name]);
}));

test('rejects corrupt legacy storage backups without changing installed bundles', () => fixture((extension, storage) => {
  const legacy = path.join(path.dirname(storage), 'local-tools.kilo-picker-helper');
  patcher.apply(extension, legacy, {hideGateway: true});
  const state = patcher.inspect(extension, legacy);
  fs.appendFileSync(state.files[0].backup, 'corrupt');
  assert.throws(() => patcher.apply(extension, storage, {fixNativeSave: true}), /原版/);
  for (const file of state.files) assert.equal(fs.readFileSync(file.target, 'utf8'), file.current);
}));

test('native save sends existing nested state and preserves success/error callbacks in both views', () => {
  for (const source of Object.values(originals)) {
    const plain = {type: 'saveCustomProvider', providerID: 'example', apiKeyChanged: false, config: {
      env: ['EXAMPLE_API_KEY'], models: {
        existing: {reasoning: true, modalities: {input: ['text', 'image'], output: ['text']}, variants: {
          high: {reasoningEffort: 'high', thinking: {type: 'enabled', budget_tokens: 4096}},
          off: {disabled: true}
        }}, added: {name: 'New model'}
      }
    }};
    const message = {...plain, config: proxyTree(plain.config)};
    const original = bridge(source, data => structuredClone(data));
    assert.throws(() => original.actions.send(message), {name: 'DataCloneError'});
    original.actions.dispose();
    const patched = patcher.transform(source, {fixNativeSave: true});
    let sent, connected = 0, failure;
    const fixed = bridge(patched, data => { sent = structuredClone(data); });
    const requestId = fixed.actions.send(message, {onConnected: () => connected++, onError: e => { failure = e; }});
    assert.deepEqual(sent, {...plain, requestId});
    assert.equal(failure, undefined);
    fixed.receive({type: 'providerConnected', requestId});
    fixed.receive({type: 'providerConnected', requestId});
    assert.equal(connected, 1);
    const nextId = fixed.actions.send(message, {onError: e => { failure = e; }});
    fixed.receive({type: 'providerActionError', requestId: nextId, message: 'Backend rejected'});
    assert.equal(failure.message, 'Backend rejected');
    fixed.actions.dispose();
    assert.equal(fixed.disposed(), true);
  }
});

test('native save recovers from serialization and transport failures without a leaked callback', () => {
  for (const source of Object.values(originals)) for (const mode of ['serialization', 'transport']) {
    let saving = true, errors = 0, connected = 0, posts = 0;
    const fixed = bridge(patcher.transform(source, {fixNativeSave: true}), () => {
      posts++;
      throw new Error('Transport failed');
    });
    const config = {};
    if (mode === 'serialization') config.circular = config;
    const id = fixed.actions.send({type: 'saveCustomProvider', providerID: 'example', config}, {
      onConnected: () => connected++,
      onError: error => {
        saving = false;
        errors++;
        assert.equal(error.type, 'providerActionError');
        assert.equal(error.providerID, 'example');
        assert.ok(error.message.length > 0);
      }
    });
    assert.equal(saving, false);
    assert.equal(errors, 1);
    assert.equal(posts, mode === 'serialization' ? 0 : 1);
    fixed.receive({type: 'providerConnected', requestId: id});
    fixed.receive({type: 'providerActionError', requestId: id});
    assert.equal(connected, 0);
    assert.equal(errors, 1);
    fixed.actions.dispose();
  }
});

test('other provider actions keep their original transport and callback behavior', () => {
  for (const source of Object.values(originals)) {
    let sent, called = 0;
    const fixed = bridge(patcher.transform(source, {fixNativeSave: true}), data => { sent = data; });
    const metadata = {test: true};
    const id = fixed.actions.send({type: 'authorizeProviderOAuth', metadata}, {onOAuthReady: () => called++});
    assert.equal(sent.metadata, metadata);
    fixed.receive({type: 'providerOAuthReady', requestId: id});
    assert.equal(called, 1);
    fixed.actions.dispose();
  }
});
test('unknown version and foreign edits do not write either bundle', () => fixture((extension, storage) => {
  fs.appendFileSync(path.join(extension, 'dist', names[1]), '// foreign change');
  assert.throws(() => patcher.apply(extension, storage, {hideGateway: true}), /原版|修改/);
  assert.equal(fs.readFileSync(path.join(extension, 'dist', names[0]), 'utf8'), originals[names[0]]);
  fs.writeFileSync(path.join(extension, 'package.json'), '{"version":"7.9.0"}');
  assert.throws(() => patcher.apply(extension, storage, {}), /尚未适配/);
}));
test('gateway filtering executes correctly for normal and explicit model lists', () => {
  for (const source of Object.values(originals)) {
    const patched = patcher.transform(source, {hideGateway: true, disableMostUsed: true});
    const match = patched.match(/\/\* local: hide kilo models \*\/(.*?)\}\)/);
    const provider = match[1].match(/providerID!==([\w$]+)/)[1];
    const models = [{providerID: 'kilo'}, {providerID: 'axnonhub'}, {providerID: 'disconnected'}];
    const context = {e: {}, t: () => ['kilo', 'axnonhub'], n: () => models, [provider]: 'kilo'};
    const filter = vm.runInNewContext(`()=>{${match[1]}}`, context);
    assert.deepEqual(filter().map(m => m.providerID), ['axnonhub']);
    context.e.models = models;
    assert.deepEqual(filter().map(m => m.providerID), ['axnonhub', 'disconnected']);
    assert.ok(patched.includes('/* local: keep most-used list empty */'));
  }
});
test('failed second write rolls back first and preserves backups', () => fixture((extension, storage) => {
  const write = fs.writeFileSync;
  const second = path.join(extension, 'dist', names[1]);
  let failed = false;
  fs.writeFileSync = function(file, ...args) {
    if (file === second && !failed) { failed = true; throw Error('injected write failure'); }
    return write.call(this, file, ...args);
  };
  try { assert.throws(() => patcher.apply(extension, storage, {hideGateway: true, disableMostUsed: true}), /injected/); }
  finally { fs.writeFileSync = write; }
  for (const name of names) assert.equal(fs.readFileSync(path.join(extension, 'dist', name), 'utf8'), originals[name]);
  assert.equal(fs.existsSync(path.join(storage, 'patch.lock')), false);
}));
