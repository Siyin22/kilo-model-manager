'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jsonc = require('jsonc-parser');
const reasoning = require('./media/reasoning');
const COMMON = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'on', 'off', 'default', '关闭'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
function parse(text) {
  const errors = [];
  const value = jsonc.parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length || !object(value)) throw new Error('配置不是有效的 JSONC 对象，请先修复语法。');
  // Duplicate keys make preservation and updates ambiguous.
  const tree = jsonc.parseTree(text.replace(/^\uFEFF/, ''));
  function walk(n) {
    if (n.type === 'object') {
      const keys = n.children.map(p => p.children[0].value);
      if (new Set(keys).size !== keys.length) throw new Error('配置有重复键，已停止操作。');
    }
    for (const child of n.children || []) walk(child);
  }
  walk(tree);
  return value;
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function read(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  return { text, value: parse(text), hash: hash(bytes) };
}
function variants(value) {
  if (!object(value)) throw new Error('档位参数必须是 JSON 对象。');
  for (const [name, settings] of Object.entries(value)) {
    if (!name.trim() || name !== name.trim() || !object(settings)) throw new Error('档位名不能为空，每个档位的参数必须为对象。');
    if (own(settings, 'disabled') && typeof settings.disabled !== 'boolean') throw new Error('disabled 必须为 true 或 false。');
    if (own(settings, 'reasoningEffort') && typeof settings.reasoningEffort !== 'string') throw new Error('reasoningEffort 必须是字符串。');
  }
  return value;
}
function safeModels(value) {
  return Object.entries(value.provider || {}).filter(([, p]) => object(p)).map(([id, p]) => ({
    id, name: typeof p.name === 'string' ? p.name : id,
    npm: p.npm || '@ai-sdk/openai-compatible', baseURL: typeof p.options?.baseURL === 'string' ? p.options.baseURL : '',
    models: Object.entries(p.models || {}).filter(([, m]) => object(m)).map(([id, m]) => ({
      id, name: typeof m.name === 'string' ? m.name : id, reasoning: m.reasoning === true,
      images: Array.isArray(m.modalities?.input) && m.modalities.input.includes('image'),
      variants: variants(m.variants || {}), reasoningOptions: reasoning.pick(m.options)
    }))
  }));
}
function update(text, command) {
  const original = parse(text);
  const provider = original.provider?.[command.provider];
  if (!object(provider)) throw new Error('提供商不存在。');
  const id = command.id;
  if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 300) throw new Error('模型 ID 不合法。');
  const exists = own(provider.models || {}, id);
  if (command.action === 'add' && exists) throw new Error('模型 ID 已存在，请使用编辑。');
  if (command.action !== 'add' && !exists) throw new Error('模型不存在，请刷新。');
  if (!['add', 'edit', 'delete'].includes(command.action)) throw new Error('不支持的操作。');
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let output = text.slice(bom.length);
  const indent = output.match(/\n([\t ]+)"/)?.[1] || '  ';
  const options = { formattingOptions: { insertSpaces: !indent.includes('\t'), tabSize: indent.length || 2, eol: output.includes('\r\n') ? '\r\n' : '\n' } };
  const root = ['provider', command.provider, 'models', id];
  function set(parts, value) { output = jsonc.applyEdits(output, jsonc.modify(output, parts, value, options)); }
  if (command.action === 'delete') set(root, undefined);
  else {
    if (typeof command.name !== 'string' || !command.name.trim()) throw new Error('显示名称不能为空。');
    if (typeof command.reasoning !== 'boolean' || typeof command.images !== 'boolean') throw new Error('能力设置不合法。');
    const selected = variants(command.variants);
    const previous = exists ? provider.models[id] : {};
    const merged = Object.fromEntries(Object.entries(selected));
    for (const key of new Set([...COMMON, ...Object.keys(previous.variants || {})])) {
      if (!own(merged, key)) Object.defineProperty(merged, key, {value: {...previous.variants?.[key], disabled: true}, enumerable: true});
    }
    if (!exists) set(root, {});
    set([...root, 'name'], command.name.trim());
    set([...root, 'reasoning'], command.reasoning);
    const inputs = new Set(previous.modalities?.input || []);
    if (command.images) { inputs.add('text'); inputs.add('image'); }
    else inputs.delete('image');
    if (previous.modalities?.input || command.images) set([...root, 'modalities', 'input'], [...inputs]);
    set([...root, 'variants'], merged);
    if (command.reasoningMode !== undefined) {
      if (!['graded', 'switch'].includes(command.reasoningMode)) throw Error('推理模式不合法。');
      const defaults = command.defaultOptions || {};
      if (!object(defaults) || Object.keys(defaults).some(key => !reasoning.keys.includes(key))) throw Error('默认思考参数包含不支持的字段。');
      if (command.reasoningMode === 'switch' && (!object(selected['关闭']) || Object.keys(selected).length !== 1 || selected['关闭'].disabled || !Object.keys(selected['关闭']).length || !Object.keys(defaults).length)) throw Error('开关模式需要默认开启参数和关闭参数。');
      if (command.reasoningMode === 'graded' && Object.keys(defaults).length) throw Error('分级模式不应附带默认开关参数。');
      const nextOptions = {...previous.options};
      for (const key of reasoning.keys) delete nextOptions[key];
      Object.assign(nextOptions, defaults);
      if (Object.keys(nextOptions).length || previous.options) set([...root, 'options'], nextOptions);
    }
  }
  const result = bom + output;
  parse(result);
  return result;
}
function commit(file, expectedHash, text) {
  parse(text);
  const current = fs.readFileSync(file);
  if (hash(current) !== expectedHash) throw new Error('配置已被其他程序修改。请先刷新，重新应用修改。');
  const backup = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  fs.writeFileSync(backup, current, { flag: 'wx', mode: 0o600 });
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: fs.statSync(file).mode });
    if (hash(fs.readFileSync(file)) !== expectedHash) throw new Error('保存前检测到配置变化，已取消。');
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return backup;
}
function edit(text, edits) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let output = text.slice(bom.length);
  const indent = output.match(/\n([\t ]+)"/)?.[1] || '  ';
  for (const [parts, value] of edits) output = jsonc.applyEdits(output, jsonc.modify(output, parts, value, {formattingOptions: {insertSpaces: !indent.includes('\t'), tabSize: indent.length, eol: output.includes('\r\n') ? '\r\n' : '\n'}}));
  parse(bom + output);
  return bom + output;
}
function updateProvider(text, command) {
  const data = parse(text), id = command.id;
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(id) || id.length > 100 || ['__proto__', 'constructor', 'prototype', 'kilo'].includes(id)) throw Error('供应商 ID 请使用小写字母、数字、短横线或下划线，不能使用保留名称。');
  const exists = own(data.provider || {}, id);
  if (!['add', 'edit'].includes(command.action) || (command.action === 'add' && exists) || (command.action === 'edit' && !exists)) throw Error('供应商已存在或编辑目标不存在，请刷新。');
  if (typeof command.name !== 'string' || !command.name.trim()) throw Error('供应商名称不能为空。');
  if (!['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic'].includes(command.npm)) throw Error('不支持的供应商协议。');
  const url = new URL(command.baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('API 地址必须是 HTTP(S) 地址，不能含用户名、密码、查询参数或片段。');
  if (command.apiKey !== undefined && (typeof command.apiKey !== 'string' || /[\r\n]/.test(command.apiKey))) throw Error('API Key 不合法。');
  const root = ['provider', id];
  const edits = [[root.concat('name'), command.name.trim()], [root.concat('npm'), command.npm], [root.concat('options', 'baseURL'), command.baseURL.trim().replace(/\/+$/, '')]];
  if (!exists || !data.provider[id].models) edits.push([root.concat('models'), {}]);
  if (command.apiKey?.trim()) edits.push([root.concat('options', 'apiKey'), command.apiKey.trim()]);
  if (data.disabled_providers?.includes(id)) edits.push([['disabled_providers'], data.disabled_providers.filter(value => value !== id)]);
  return edit(text, edits);
}
function importModels(text, providerID, models) {
  const data = parse(text), provider = data.provider?.[providerID];
  if (!object(provider) || !Array.isArray(models) || !models.length || models.length > 2000) throw Error('请选择要导入的模型。');
  const seen = new Set(Object.keys(provider.models || {})), edits = [];
  for (const model of models) {
    if (typeof model.id !== 'string' || !model.id.trim() || model.id !== model.id.trim() || model.id.length > 300) throw Error('模型 ID 不合法。');
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    edits.push([['provider', providerID, 'models', model.id], {name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id}]);
  }
  if (!edits.length) throw Error('选中的模型均已存在，没有需要导入的模型。');
  return edit(text, edits);
}
module.exports = { parse, read, update, commit, hash, safeModels, variants, updateProvider, importModels };
