'use strict';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let providers = [], current = null, adding = false, revision = '', dirty = false, pending = false;
const provider = () => providers.find(p => p.id === $('provider').value);
const active = v => Object.fromEntries(Object.entries(v || {}).filter(([, s]) => !s.disabled));
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function busy(value) {
  pending = value;
  for (const el of document.querySelectorAll('button,input,select,textarea')) el.disabled = value;
}
function send(message) { busy(true); vscode.postMessage(message); }
function discard() { if (dirty) { status('有未保存修改。请保存，或点击“清空未保存修改”后再切换。', true); return false; } return true; }
// Webviews do not reliably support window.confirm. Explicit discard button instead.
const discardButton = document.createElement('button');
discardButton.type = 'button'; discardButton.className = 'secondary'; discardButton.textContent = '清空未保存修改';
$('save').parentElement.append(discardButton);
discardButton.addEventListener('click', () => { dirty = false; show(current, adding); status('已撤销页面中未保存的修改。'); });
function values() {
  const value = JSON.parse($('variants').value);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('档位必须是 JSON 对象');
  for (const [name, settings] of Object.entries(value)) {
    if (!name.trim() || !settings || Array.isArray(settings) || typeof settings !== 'object') throw Error('每个档位的参数必须是对象');
  }
  return value;
}
function command() { return {action: adding ? 'add' : 'edit', provider: $('provider').value, id: $('modelId').value.trim(), name: $('modelName').value.trim(), reasoning: $('reasoning').checked, images: $('images').checked, variants: values()}; }
function preview() {
  try {
    const cmd = command();
    const before = current ? {name: current.name, reasoning: current.reasoning, images: current.images, variants: active(current.variants)} : null;
    $('preview').textContent = JSON.stringify({模型: cmd.id, 修改前: before, 修改后: {name: cmd.name, reasoning: cmd.reasoning, images: cmd.images, variants: cmd.variants}}, null, 2);
    for (const name of levels) $('level-' + name).checked = !!cmd.variants[name] && !cmd.variants[name].disabled;
  } catch (error) { $('preview').textContent = '参数暂不可保存：' + error.message; }
}
function list() {
  $('list').replaceChildren();
  const search = $('search').value.toLowerCase();
  const sorted = [...(provider()?.models || [])].sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base', numeric: true }));
  for (const model of sorted) {
    if (!(model.id + ' ' + model.name).toLowerCase().includes(search)) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'model';
    button.classList.toggle('selected', !adding && current?.id === model.id);
    button.textContent = model.name;
    const sub = document.createElement('small'); sub.textContent = model.id + ' · ' + (Object.keys(active(model.variants)).join(' / ') || '未配置档位'); button.append(sub);
    button.addEventListener('click', () => { if (!pending && discard()) show(model, false); }); $('list').append(button);
  }
}
function show(model, isNew) {
  current = model; adding = isNew; dirty = false;
  $('form').hidden = !model && !isNew; $('empty').hidden = !!model || isNew;
  $('heading').textContent = isNew ? '添加模型' : '编辑模型';
  $('modelId').value = model?.id || ''; $('modelId').readOnly = !isNew;
  $('modelName').value = model?.name || ''; $('reasoning').checked = model?.reasoning ?? true; $('images').checked = model?.images ?? false;
  $('variants').value = JSON.stringify(active(model?.variants), null, 2);
  $('delete').hidden = isNew; preview(); list();
}
for (const name of levels) {
  const label = document.createElement('label'), input = document.createElement('input');
  input.type = 'checkbox'; input.id = 'level-' + name; label.append(input, document.createTextNode(name)); $('levels').append(label);
  input.addEventListener('change', () => {
    try { const v = values(); if (input.checked) Object.defineProperty(v, name, {value: {reasoningEffort: name}, enumerable: true, configurable: true}); else delete v[name]; $('variants').value = JSON.stringify(v, null, 2); dirty = true; preview(); }
    catch (e) { input.checked = !input.checked; status('请先修复 JSON：' + e.message, true); }
  });
}
$('form').addEventListener('input', event => { if (event.target.id.startsWith('level-')) return; dirty = true; preview(); });
$('form').addEventListener('submit', e => { e.preventDefault(); try { send({type: 'save', revision, command: command()}); } catch (error) { status(error.message, true); } });
$('delete').addEventListener('click', () => { if (current) send({type: 'save', revision, command: {action: 'delete', provider: $('provider').value, id: current.id}}); });
$('toggle').addEventListener('click', () => { $('variants').value = JSON.stringify({on: {reasoningEffort: 'high'}, off: {reasoningEffort: 'none'}}, null, 2); dirty = true; preview(); });
$('clear').addEventListener('click', () => { $('variants').value = '{}'; dirty = true; preview(); });
$('add').addEventListener('click', () => { if (provider() && discard()) show(null, true); });
let providerId = '';
$('provider').addEventListener('change', () => { if (!discard()) { $('provider').value = providerId; return; } providerId = $('provider').value; show(null, false); });
$('search').addEventListener('input', list);
for (const name of ['refresh', 'restore', 'reload']) $(name).addEventListener('click', () => { if (discard()) send({type: name}); });
window.addEventListener('message', event => {
  const m = event.data;
  if (m.type === 'data') {
    const previousId = adding ? $('modelId').value.trim() : current?.id;
    providers = m.providers; revision = m.revision; $('file').textContent = m.file;
    $('provider').replaceChildren(...providers.map(p => { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name + ' (' + p.id + ')'; return option; }));
    if (providers.some(p => p.id === providerId)) $('provider').value = providerId;
    providerId = $('provider').value;
    show(provider()?.models.find(x => x.id === previousId) || null, false);
    status(providers.length ? '配置已读取。修改后请核对预览并保存。' : '未找到自定义模型提供商，请先在 Kilo 中配置提供商。');
  } else if (m.type === 'notice' || m.type === 'error') status(m.text, m.type === 'error');
  else if (m.type === 'done') busy(false);
});
send({type: 'ready'});
