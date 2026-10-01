'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const config = require('./config');

function activate(context) {
  require('./picker').activate(context);
  let panel;
  context.subscriptions.push(vscode.commands.registerCommand('kiloModelManager.open', () => {
    if (panel) { panel.reveal(); return; }
    const custom = vscode.workspace.getConfiguration('kiloModelManager').get('configPath');
    const base = path.join(os.homedir(), '.config', 'kilo');
    const file = custom || (fs.existsSync(path.join(base, 'kilo.jsonc')) ? path.join(base, 'kilo.jsonc') : path.join(base, 'kilo.json'));
    if (!path.isAbsolute(file) || !fs.existsSync(file)) {
      vscode.window.showErrorMessage('未找到 Kilo 配置。请在设置 kiloModelManager.configPath 中填写配置文件的绝对路径。');
      return;
    }
    panel = vscode.window.createWebviewPanel('kiloModelManager', 'Kilo 模型与推理设置', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    const active = panel;
    let snapshot, busy = false, catalog;
    const post = data => active.webview.postMessage(data);
    function refresh(selectedProvider) {
      const next = config.read(file);
      const providers = config.safeModels(next.value);
      snapshot = next;
      catalog = undefined;
      post({type: 'data', providers, file, revision: next.hash, selectedProvider});
    }
    function currentSnapshot(message) {
      if (!snapshot || message.revision !== snapshot.hash || config.read(file).hash !== snapshot.hash) throw Error('配置已变化，请刷新后重试。');
      return snapshot;
    }
    active.webview.html = html(active.webview, context.extensionUri);
    const subscription = active.webview.onDidReceiveMessage(async message => {
      if (busy) return;
      busy = true;
      try {
        if (message.type === 'ready' || message.type === 'refresh') refresh();
        else if (message.type === 'pickerSettings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.kilo-model-manager-local');
        else if (message.type === 'saveProvider') {
          currentSnapshot(message);
          const next = config.updateProvider(snapshot.text, message.command);
          if (await vscode.window.showInformationMessage(`保存供应商 ${message.command.id}？`, {modal: true, detail: '连接信息会保存到 Kilo 配置，当前配置会先备份。已有模型保持不变。'}, '保存') !== '保存') return;
          config.commit(file, snapshot.hash, next);
          refresh(message.command.id);
          post({type: 'notice', text: '供应商已保存。可以读取模型列表，或手动添加模型。'});
        } else if (message.type === 'fetchModels') {
          const current = currentSnapshot(message);
          const provider = current.value.provider?.[message.provider];
          if (!provider) throw Error('供应商不存在。');
          catalog = undefined;
          const models = await require('./providers').fetchModels(provider, message.provider);
          if (config.read(file).hash !== current.hash) throw Error('读取期间配置已变化，请刷新后重试。');
          catalog = {provider: message.provider, revision: current.hash, models};
          post({type: 'catalog', provider: message.provider, models});
        } else if (message.type === 'importModels') {
          currentSnapshot(message);
          if (!catalog || catalog.provider !== message.provider || catalog.revision !== snapshot.hash || !Array.isArray(message.ids)) throw Error('模型列表已失效，请重新读取。');
          const ids = new Set(message.ids), models = catalog.models.filter(model => ids.has(model.id));
          if (models.length !== ids.size) throw Error('选择包含未知模型，请重新读取。');
          const next = config.importModels(snapshot.text, message.provider, models);
          if (await vscode.window.showInformationMessage(`导入 ${models.length} 个模型？`, {modal: true, detail: '只添加不存在的模型，保留已有模型的配置。导入后可逐个设置图片能力和推理模式。'}, '导入') !== '导入') return;
          config.commit(file, snapshot.hash, next);
          refresh(message.provider);
          post({type: 'notice', text: '模型已导入，请按模型实际能力设置推理模式与图片支持。'});
        } else if (message.type === 'save') {
          if (!snapshot || message.revision !== snapshot.hash) throw new Error('页面版本已过期，请刷新。');
          const current = config.read(file);
          if (current.hash !== snapshot.hash) throw new Error('配置已被其他程序修改，请先刷新后重试。');
          const next = config.update(snapshot.text, message.command);
          const cmd = message.command;
          if (cmd.action === 'delete') {
            if (await vscode.window.showWarningMessage(`删除模型 ${cmd.id}？当前配置会先备份。`, {modal: true}, '删除') !== '删除') return;
          } else {
            const selected = Object.entries(cmd.variants).filter(([, v]) => !v.disabled).map(([k]) => k).join(' / ') || '使用模型默认设置';
            if (await vscode.window.showInformationMessage(`保存 ${cmd.id}？`, {modal: true, detail: `提供商：${cmd.provider}\n显示名称：${cmd.name}\n推理：${cmd.reasoning ? '是' : '否'}；图片：${cmd.images ? '是' : '否'}\n模式：${cmd.reasoningMode === 'switch' ? '模型默认配置（默认／关闭）' : '推理强度分级'}\n档位：默认 / ${selected}\n具体请求参数请核对页面预览。保存前自动备份。`}, '保存') !== '保存') return;
          }
          const backup = config.commit(file, snapshot.hash, next);
          refresh();
          post({type: 'notice', text: `已保存。备份：${path.basename(backup)}。若 Kilo 未刷新，请重新加载窗口。`});
        } else if (message.type === 'restore') {
          const before = fs.readFileSync(file);
          const dir = path.dirname(file), prefix = path.basename(file) + '.bak-';
          const backups = fs.readdirSync(dir).filter(n => n.startsWith(prefix)).sort().reverse();
          if (!backups.length) throw new Error('未找到配置备份。');
          const selected = await vscode.window.showQuickPick(backups, {title: '选择完整配置备份', placeHolder: '恢复会替换提供商、模型及其他所有设置'});
          if (!selected) return;
          const restored = fs.readFileSync(path.join(dir, selected), 'utf8');
          config.parse(restored);
          if (await vscode.window.showWarningMessage('恢复整个 Kilo 配置？', {modal: true, detail: `${selected}\n将覆盖所有配置项；当前文件会先备份。`}, '恢复') !== '恢复') return;
          config.commit(file, config.hash(before), restored);
          refresh(); post({type: 'notice', text: '已恢复完整配置，并备份恢复前的文件。'});
        } else if (message.type === 'reload') {
          if (await vscode.window.showInformationMessage('重新加载 VS Code 窗口？这会重启当前窗口中的扩展。', {modal: true}, '重新加载') === '重新加载') await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (error) { post({type: 'error', text: error.message || String(error)}); }
      finally { busy = false; post({type: 'done'}); }
    });
    active.onDidDispose(() => { subscription.dispose(); panel = undefined; });
  }));
}

function html(webview, uri) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(uri, 'media', 'style.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(uri, 'media', 'app.js'));
  const reasoning = webview.asWebviewUri(vscode.Uri.joinPath(uri, 'media', 'reasoning.js'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}"><title>Kilo 模型与推理设置</title></head><body>
  <header><div><h1>Kilo 模型工具箱</h1><p>管理自定义模型、推理选项与模型分组</p></div><div class="actions"><button id="pickerSettings" class="secondary">分组与保存修复</button><button id="refresh" class="secondary">刷新</button><button id="restore" class="secondary">恢复配置备份</button><button id="reload" class="secondary">重新加载窗口</button></div></header>
  <p id="file" class="muted"></p><div id="status" role="status" aria-live="polite">正在读取配置…</div>
  <div class="layout"><aside><label for="provider">供应商</label><select id="provider"></select><div class="actions"><button id="addProvider" class="secondary">＋ 添加供应商</button><button id="editProvider" class="secondary">编辑供应商</button><button id="fetchModels" class="secondary">读取供应商模型</button></div><label for="search">查找模型</label><input id="search" placeholder="输入 ID 或名称"><button id="add">＋ 添加模型</button><div id="list"></div></aside>
  <main><div id="empty">请选择模型，或添加供应商后读取模型列表。</div>
  <form id="providerForm" hidden><h2 id="providerHeading">添加供应商</h2><div class="grid"><label>供应商 ID<input id="providerId" required pattern="[a-z0-9]+([-_][a-z0-9]+)*" maxlength="100" placeholder="my-provider"></label><label>显示名称<input id="providerName" required></label></div><label>API 协议<select id="providerProtocol"><option value="@ai-sdk/openai-compatible">OpenAI 兼容</option><option value="@ai-sdk/openai">OpenAI</option><option value="@ai-sdk/anthropic">Anthropic</option></select></label><label>API 地址<input id="providerURL" type="url" required placeholder="https://api.example.com/v1"></label><label>API Key<input id="providerKey" type="password" autocomplete="new-password" placeholder="编辑时留空保留原凭据，也可使用 {env:变量名}"></label><p class="muted">API Key 保存在本地 Kilo 配置中，已有密钥不会显示在页面。地址应包含供应商要求的版本路径。</p><div class="actions"><button type="submit">保存供应商</button><button type="button" id="cancelProvider" class="secondary">取消</button></div></form>
  <section id="catalogPanel" hidden><h2>供应商模型列表</h2><p class="muted">勾选后导入；已有模型不会被覆盖。列表接口通常不提供准确的推理和图片能力，导入后请单独设置。</p><input id="catalogSearch" placeholder="搜索模型 ID 或名称"><div class="actions"><button id="selectCatalog" type="button" class="secondary">全选搜索结果</button><button id="clearCatalog" type="button" class="secondary">清空选择</button><span id="catalogCount"></span></div><div id="catalogList"></div><div class="actions"><button id="importModels" type="button">导入所选模型</button><button id="closeCatalog" type="button" class="secondary">取消</button></div></section>
  <form id="form" hidden><h2 id="heading">编辑模型</h2><div class="grid"><label>模型 ID<input id="modelId" required maxlength="300"></label><label>显示名称<input id="modelName" required></label></div>
  <div class="checks"><label><input type="checkbox" id="reasoning">模型具备推理能力</label><label><input type="checkbox" id="images">支持图片</label></div>
  <section><h3>推理配置</h3><label>配置模式<select id="reasoningMode"><option value="graded">推理强度分级</option><option value="switch">模型默认配置（开关思考模式）</option></select></label><p class="hint">使用页保留原生“默认”选项。分级模式选择强度；开关模式只提供“默认／关闭”，默认参数用于开启思考。模板需与供应商协议匹配。</p>
  <div id="gradedFields"><div id="levels" class="checks"></div><div class="actions"><button type="button" id="defaults" class="secondary">仅保留默认档位</button></div><label for="variants">档位与请求参数（JSON）</label><textarea id="variants" rows="10" spellcheck="false"></textarea><p class="muted">未选择的旧档位会被禁用，默认不附加档位参数。</p></div>
  <div id="switchFields" hidden><label>思考开关协议<select id="thinkingProtocol"></select></label><button id="applyThinkingTemplate" type="button" class="secondary">填入协议模板</button><label>默认（开启思考）参数<textarea id="thinkingOn" rows="5" spellcheck="false"></textarea></label><label>关闭思考参数<textarea id="thinkingOff" rows="5" spellcheck="false"></textarea></label><p class="muted">保存时替换模型 options 中的思考控制字段，其他参数保留。供应商自身不支持关闭时，该选项不能强制模型关闭。</p></div></section>
  <section><h3>修改预览</h3><pre id="preview"></pre></section><div class="actions"><button type="submit" id="save">确认并保存</button><button type="button" id="delete" class="danger">删除模型</button></div></form></main></div>
  <script nonce="${nonce}" src="${reasoning}"></script><script nonce="${nonce}" src="${js}"></script></body></html>`;
}
module.exports = {activate};
