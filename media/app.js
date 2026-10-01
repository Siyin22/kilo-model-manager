'use strict';
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const reasoning = globalThis.KiloReasoning;
let providers = [], current = null, adding = false, revision = '', dirty = false, pending = false;
const provider = () => providers.find(p => p.id === $('provider').value);
const active = v => Object.fromEntries(Object.entries(v || {}).filter(([, s]) => !s.disabled));
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function busy(value) {
  pending = value;
  for (const el of document.querySelectorAll('button,input,select,textarea')) el.disabled = value;
}
function send(message) { busy(true); vscode.postMessage(message); }
$('pickerSettings').addEventListener('click', () => send({type: 'pickerSettings'}));
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
function jsonObject(id) {
  const value = JSON.parse($(id).value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('思考参数必须为 JSON 对象。');
  return value;
}
function command() {
  const enabled = $('reasoning').checked;
  const mode = $('reasoningMode').value;
  const variants = !enabled ? active(current?.variants) : mode === 'switch' ? {'关闭': jsonObject('thinkingOff')} : values();
  return {action: adding ? 'add' : 'edit', provider: $('provider').value, id: $('modelId').value.trim(), name: $('modelName').value.trim(), reasoning: enabled, images: $('images').checked, ...(enabled ? {reasoningMode: mode, defaultOptions: mode === 'switch' ? jsonObject('thinkingOn') : {}} : {}), variants};
}
function preview() {
  try {
    const cmd = command();
    const before = current ? {name: current.name, reasoning: current.reasoning, images: current.images, 默认参数: current.reasoningOptions || {}, variants: active(current.variants)} : null;
    $('preview').textContent = JSON.stringify({模型: cmd.id, 修改前: before, 修改后: {name: cmd.name, reasoning: cmd.reasoning, images: cmd.images, 模式: cmd.reasoningMode, 默认参数: cmd.defaultOptions, variants: cmd.variants}}, null, 2);
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
    const sub = document.createElement('small'); sub.textContent = model.id + ' · ' + (Object.keys(active(model.variants)).join(' / ') || '使用模型默认设置'); button.append(sub);
    button.addEventListener('click', () => { if (!pending && discard()) show(model, false); }); $('list').append(button);
  }
}
function show(model, isNew) {
  current = model; adding = isNew; dirty = false;
  $('providerForm').hidden = true; $('catalogPanel').hidden = true; $('providerKey').value = '';
  $('form').hidden = !model && !isNew; $('empty').hidden = !!model || isNew;
  $('heading').textContent = isNew ? '添加模型' : '编辑模型';
  $('modelId').value = model?.id || ''; $('modelId').readOnly = !isNew;
  $('modelName').value = model?.name || ''; $('reasoning').checked = model?.reasoning ?? true; $('images').checked = model?.images ?? false;
  $('variants').value = JSON.stringify(active(model?.variants), null, 2);
  $('reasoningMode').value = model ? reasoning.mode(model) : 'graded';
  $('thinkingOn').value = JSON.stringify(model?.reasoningOptions || {}, null, 2);
  const off = active(model?.variants)['关闭'] || active(model?.variants).off || {};
  $('thinkingOff').value = JSON.stringify(off, null, 2);
  $('thinkingProtocol').value = 'custom';
  updateMode();
  $('delete').hidden = isNew; preview(); list();
}
function updateMode() {
  $('gradedFields').hidden = $('reasoningMode').value !== 'graded';
  $('switchFields').hidden = $('reasoningMode').value !== 'switch';
}
for (const [id, template] of Object.entries(reasoning.templates)) {
  const option = document.createElement('option'); option.value = id; option.textContent = template.label; $('thinkingProtocol').append(option);
}
const customTemplate = document.createElement('option'); customTemplate.value = 'custom'; customTemplate.textContent = '自定义／保留当前参数'; $('thinkingProtocol').append(customTemplate);
$('reasoningMode').addEventListener('change', () => { updateMode(); dirty = true; preview(); });
$('applyThinkingTemplate').addEventListener('click', () => {
  const template = reasoning.templates[$('thinkingProtocol').value];
  if (!template) return;
  $('thinkingOn').value = JSON.stringify(template.on, null, 2); $('thinkingOff').value = JSON.stringify(template.off, null, 2); dirty = true; preview();
});
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
$('defaults').addEventListener('click', () => { $('reasoningMode').value = 'graded'; updateMode(); $('variants').value = '{}'; dirty = true; preview(); });
$('add').addEventListener('click', () => { if (provider() && discard()) show(null, true); });
let providerId = '';
$('provider').addEventListener('change', () => { if (!discard()) { $('provider').value = providerId; return; } providerId = $('provider').value; show(null, false); });
$('search').addEventListener('input', list);
for (const name of ['refresh', 'restore', 'reload']) $(name).addEventListener('click', () => { if (discard()) send({type: name}); });
let providerEditing = false, catalogModels = [], selectedModels = new Set();
function editProvider(editing) {
  if (!discard()) return;
  const value = editing ? provider() : null;
  if (editing && !value) return;
  providerEditing = editing;
  $('form').hidden = true; $('empty').hidden = true; $('catalogPanel').hidden = true; $('providerForm').hidden = false;
  $('providerHeading').textContent = editing ? '编辑供应商' : '添加供应商';
  $('providerId').value = value?.id || ''; $('providerId').readOnly = editing;
  $('providerName').value = value?.name || ''; $('providerURL').value = value?.baseURL || ''; $('providerKey').value = '';
  $('providerProtocol').value = value?.npm || '@ai-sdk/openai-compatible';
}
$('addProvider').addEventListener('click', () => editProvider(false));
$('editProvider').addEventListener('click', () => editProvider(true));
$('providerForm').addEventListener('input', () => { dirty = true; });
$('cancelProvider').addEventListener('click', () => { dirty = false; show(current, adding); });
$('providerForm').addEventListener('submit', event => {
  event.preventDefault();
  send({type: 'saveProvider', revision, command: {action: providerEditing ? 'edit' : 'add', id: $('providerId').value.trim(), name: $('providerName').value.trim(), npm: $('providerProtocol').value, baseURL: $('providerURL').value.trim(), apiKey: $('providerKey').value.trim()}});
});
$('fetchModels').addEventListener('click', () => {
  if (!provider() || !discard()) return;
  status('正在读取供应商模型列表…');
  send({type: 'fetchModels', provider: provider().id, revision});
});
function filteredCatalog() { const query = $('catalogSearch').value.trim().toLowerCase(); return catalogModels.filter(model => (model.id + ' ' + model.name).toLowerCase().includes(query)); }
function renderCatalog() {
  const existing = new Set(provider()?.models.map(model => model.id));
  $('catalogList').replaceChildren();
  for (const model of filteredCatalog()) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = selectedModels.has(model.id); input.disabled = existing.has(model.id); input.dataset.existing = String(existing.has(model.id));
    input.addEventListener('change', () => { if (input.checked) selectedModels.add(model.id); else selectedModels.delete(model.id); $('catalogCount').textContent = `已选 ${selectedModels.size} 个`; });
    label.append(input, document.createTextNode(` ${model.id}${model.name !== model.id ? ' · ' + model.name : ''}${existing.has(model.id) ? '（已存在）' : ''}`)); $('catalogList').append(label);
  }
  $('catalogCount').textContent = `共 ${catalogModels.length} 个，已选 ${selectedModels.size} 个`;
}
$('catalogSearch').addEventListener('input', renderCatalog);
$('selectCatalog').addEventListener('click', () => { const existing = new Set(provider()?.models.map(model => model.id)); for (const model of filteredCatalog()) if (!existing.has(model.id)) selectedModels.add(model.id); renderCatalog(); });
$('clearCatalog').addEventListener('click', () => { selectedModels.clear(); renderCatalog(); });
$('closeCatalog').addEventListener('click', () => show(current, adding));
$('importModels').addEventListener('click', () => { if (!selectedModels.size) return status('请先勾选要导入的模型。', true); send({type: 'importModels', revision, provider: provider().id, ids: [...selectedModels]}); });
window.addEventListener('message', event => {
  const m = event.data;
  if (m.type === 'data') {
    const previousId = adding ? $('modelId').value.trim() : current?.id;
    providers = m.providers; revision = m.revision; $('file').textContent = m.file;
    $('provider').replaceChildren(...providers.map(p => { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name + ' (' + p.id + ')'; return option; }));
    if (m.selectedProvider) providerId = m.selectedProvider;
    if (providers.some(p => p.id === providerId)) $('provider').value = providerId;
    providerId = $('provider').value;
    show(provider()?.models.find(x => x.id === previousId) || null, false);
    status(providers.length ? '配置已读取。修改后请核对预览并保存。' : '暂无供应商，点击“添加供应商”开始配置。');
  } else if (m.type === 'catalog') {
    if (m.provider !== provider()?.id) return;
    catalogModels = m.models; selectedModels.clear(); $('catalogSearch').value = '';
    $('form').hidden = true; $('providerForm').hidden = true; $('empty').hidden = true; $('catalogPanel').hidden = false;
    renderCatalog(); status(m.models.length ? '读取完成，请勾选要导入的模型。' : '供应商返回了空模型列表。');
  } else if (m.type === 'notice' || m.type === 'error') status(m.text, m.type === 'error');
  else if (m.type === 'done') { busy(false); if (!$('catalogPanel').hidden) renderCatalog(); }
});
send({type: 'ready'});
