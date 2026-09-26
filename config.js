'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jsonc = require('jsonc-parser');
const COMMON = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'on', 'off', 'default'];
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
  return Object.entries(value.provider || {}).filter(([, p]) => object(p) && object(p.models)).map(([id, p]) => ({
    id, name: typeof p.name === 'string' ? p.name : id,
    models: Object.entries(p.models).filter(([, m]) => object(m)).map(([id, m]) => ({
      id, name: typeof m.name === 'string' ? m.name : id, reasoning: m.reasoning === true,
      images: Array.isArray(m.modalities?.input) && m.modalities.input.includes('image'),
      variants: variants(m.variants || {})
    }))
  }));
}
function update(text, command) {
  const original = parse(text);
  const provider = original.provider?.[command.provider];
  if (!object(provider) || !object(provider.models)) throw new Error('提供商不存在或没有 models 配置。');
  const id = command.id;
  if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 300) throw new Error('模型 ID 不合法。');
  const exists = own(provider.models, id);
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
module.exports = { parse, read, update, commit, hash, safeModels, variants };
