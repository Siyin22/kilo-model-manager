'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const files = ['webview.js', 'agent-manager.js'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const signatures = require('./signatures.json');
function fixNativeSave(source, legacy = false) {
  // Anchor to provider actions: the Anaconda bridge has an identical send function.
  const anchor = 'o.type==="providerActionError"&&s.onError?.(o)}});';
  const send = 'function r(o,s={}){let l=crypto.randomUUID();return t.set(l,s),e.postMessage({...o,requestId:l}),l}';
  const original = anchor + send;
  if (source.split(original).length !== 2) throw Error('原生模型保存结构不兼容。');
  const replacement = 'function r(o,s={}){let l=crypto.randomUUID();' +
    '/* local: serialize native provider save */if(o.type==="saveCustomProvider"){' +
    't.set(l,s);try{e.postMessage(JSON.parse(JSON.stringify({...o,requestId:l})))}' +
    'catch(error){t.delete(l);s.onError?.({type:"providerActionError",requestId:l,providerID:o.providerID,action:"connect",message:error instanceof Error?error.message:String(error)})}' +
    'return l}return t.set(l,s),e.postMessage({...o,requestId:l}),l}';
  let result = source.replace(original, anchor + replacement);
  if (!legacy) {
    const empty = 'e.variants.length===0&&!e.value?[]:e.allowClear?[void 0,...e.variants]:e.variants';
    if (result.split(empty).length !== 2) throw Error('默认推理选项结构不兼容。');
    result = result.replace(empty, '/* local: keep native default choice */e.allowClear?[void 0,...e.variants]:e.variants');
  }
  return result;
}
function transform(source, options) {
  if (source.split('="most-used"').length !== 2) throw Error('模型选择器结构不兼容：无法唯一定位。');
  const start = source.indexOf('="most-used"');
  const label = source.indexOf('model.group.mostUsed', start);
  const end = source.indexOf('function ', label);
  if (start < 0 || label < 0 || end < 0) throw Error('模型选择器结构不兼容。');
  let section = source.slice(start, end);
  const model = /if\(e\.models\)return e\.models;let (\w+)=t\(\);return n\(\)\.filter\((\w+)=>!e\.includeAutoSmall&&\w+\(\2\)\?!1:\2\.providerID===(\w+)\|\|\1\.includes\(\2\.providerID\)\)/g;
  const matches = [...section.matchAll(model)];
  if (matches.length !== 1) throw Error('模型来源结构不兼容。');
  const [original, connected, item, provider] = matches[0];
  if (!source.includes(`${provider}="kilo"`)) throw Error('无法确认 Gateway 标识。');
  if (options.hideGateway) section = section.replace(original,
    `/* local: hide kilo models */if(e.models)return e.models.filter(${item}=>${item}.providerID!==${provider});let ${connected}=t();return n().filter(${item}=>${item}.providerID!==${provider}&&${connected}.includes(${item}.providerID))`);
  const usage = /![\w$]+\(\)&&o&&[\w$]+\.push\(\.\.\.[\w$]+\([^;]+?o\.modelUsageHistory\(\),[\w$]+\(\)\)\);/g;
  const used = [...section.matchAll(usage)];
  if (used.length !== 1) throw Error('最常用分组结构不兼容。');
  if (options.disableMostUsed) section = section.replace(used[0][0], '/* local: keep most-used list empty */');
  let result = source.slice(0, start) + section + source.slice(end);
  if (options.fixNativeSave) result = fixNativeSave(result, options.legacyNativeSave);
  new vm.Script(result); // Parse without running extension code.
  return result;
}
function* variants(original) {
  for (const hideGateway of [false, true]) for (const disableMostUsed of [false, true]) for (const fixNativeSave of [false, true]) {
    const options = {hideGateway, disableMostUsed, fixNativeSave};
    yield {options, content: transform(original, options)};
    if (fixNativeSave) yield {options, content: transform(original, {...options, legacyNativeSave: true})};
  }
}
function inspect(extension, storage) {
  const version = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Kilo 版本信息无效，未修改文件。');
  const verified = Object.hasOwn(signatures, version);
  const identity = path.resolve(extension).toLowerCase();
  // Keep existing verified backups in place. Unlisted versions get separate
  // baselines even when an updater reuses the same installation directory.
  const directory = path.join(storage, hash(verified ? identity : `${identity}\n${version}`).slice(0, 24));
  const receiptPath = path.join(directory, 'baseline.json');
  let receipt;
  if (!verified && fs.existsSync(receiptPath)) {
    try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
    catch { throw Error('结构适配备份记录损坏，未修改文件。'); }
    if (receipt?.schema !== 1 || receipt.version !== version || receipt.extension !== identity ||
        !files.every(name => /^[a-f0-9]{64}$/.test(receipt.hashes?.[name]))) {
      throw Error('结构适配备份记录不匹配，未修改文件。');
    }
  }
  const result = files.map(name => {
    const target = path.join(extension, 'dist', name);
    const current = fs.readFileSync(target, 'utf8');
    const backup = path.join(directory, name);
    let original;
    if (!verified) {
      if (receipt) {
        if (!fs.existsSync(backup)) throw Error(`${name} 缺少结构适配备份，未修改。`);
        original = fs.readFileSync(backup, 'utf8');
        if (hash(original) !== receipt.hashes[name]) throw Error(`${name} 备份校验失败，未修改。`);
      } else {
        if (fs.existsSync(backup)) throw Error('结构适配备份记录缺失，未修改文件。');
        original = current;
      }
      // A first-seen file is only a structural baseline, not an authenticated
      // upstream original. Never adopt one of our patched files as a baseline.
      if (original.includes('/* local:')) throw Error(`${name} 已有补丁但缺少可验证的原版，未修改。`);
      try { transform(original, {hideGateway: true, disableMostUsed: true, fixNativeSave: true}); }
      catch (error) { throw Error(`Kilo ${version} 的 ${name} 结构检查未通过：${error.message} 未修改文件。`); }
    } else {
      // Both extensions use VS Code globalStorage siblings. Only hash-verified
      // originals can be adopted; apply writes them into this extension's storage.
      const legacyBackup = path.join(path.dirname(storage), 'local-tools.kilo-picker-helper', path.basename(directory), name);
      const structuralBackup = path.join(storage, hash(`${identity}\n${version}`).slice(0, 24), name);
      const candidates = [backup, legacyBackup, structuralBackup, target, ...fs.readdirSync(path.dirname(target))
        .filter(n => n.startsWith(name + '.bak-model-picker-')).map(n => path.join(path.dirname(target), n))];
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const data = fs.readFileSync(candidate, 'utf8');
        if (hash(data) === signatures[version][name]) { original = data; break; }
      }
    }
    if (!original) throw Error(`${name} 找不到经过验证的原版文件，未修改。`);
    let known;
    for (const variant of variants(original)) if (variant.content === current) { known = variant; break; }
    if (!known) throw Error(`${name} 含有其他修改，已停止以避免覆盖。`);
    return {name, target, backup, current, original, options: known.options};
  });
  return {version, directory, files: result, compatibility: verified ? 'verified' : 'structural',
    receiptPath, receipt: !verified && !receipt ? {schema: 1, version, extension: identity,
      hashes: Object.fromEntries(result.map(file => [file.name, hash(file.original)]))} : undefined};
}
function apply(extension, storage, options) {
  fs.mkdirSync(storage, {recursive: true});
  const lock = path.join(storage, 'patch.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx'); }
  catch { throw Error('另一个窗口正在修改，或上次异常退出留下 patch.lock。请查看状态中的备份目录。'); }
  const written = [];
  try {
    const state = inspect(extension, storage);
    const plans = state.files.map(file => ({...file, next: transform(file.original, options)}));
    fs.mkdirSync(state.directory, {recursive: true});
    for (const file of plans) {
      if (!fs.existsSync(file.backup)) fs.writeFileSync(file.backup, file.original, {flag: 'wx'});
      else if (hash(fs.readFileSync(file.backup)) !== hash(file.original)) throw Error('备份校验失败。');
    }
    // Persist both baseline hashes before touching either installed bundle.
    if (state.receipt) {
      fs.writeFileSync(state.receiptPath, JSON.stringify(state.receipt, null, 2) + '\n', {flag: 'wx'});
    }
    for (const file of plans) {
      if (fs.readFileSync(file.target, 'utf8') !== file.current) throw Error('Kilo 文件在检查期间发生变化，请重试。');
      if (file.current === file.next) continue;
      written.push(file);
      fs.writeFileSync(file.target, file.next);
      if (fs.readFileSync(file.target, 'utf8') !== file.next) throw Error('写入校验失败。');
    }
    return {changed: written.length > 0, version: state.version, compatibility: state.compatibility};
  } catch (error) {
    for (const file of written.reverse()) fs.writeFileSync(file.target, file.current);
    throw error;
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}
module.exports = {transform, inspect, apply, hash};
