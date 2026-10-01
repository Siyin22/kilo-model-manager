'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const config = require('./config');

function activate(context) {
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
    let snapshot, busy = false;
    const post = data => active.webview.postMessage(data);
    function refresh() {
      const next = config.read(file);
      const providers = config.safeModels(next.value);
      snapshot = next;
      post({type: 'data', providers, file, revision: next.hash});
    }
    active.webview.html = html(active.webview, context.extensionUri);
    const subscription = active.webview.onDidReceiveMessage(async message => {
      if (busy) return;
      busy = true;
      try {
        if (message.type === 'ready' || message.type === 'refresh') refresh();
        else if (message.type === 'save') {
          if (!snapshot || message.revision !== snapshot.hash) throw new Error('页面版本已过期，请刷新。');
          const current = config.read(file);
          if (current.hash !== snapshot.hash) throw new Error('配置已被其他程序修改，请先刷新后重试。');
          const next = config.update(snapshot.text, message.command);
          const cmd = message.command;
          if (cmd.action === 'delete') {
            if (await vscode.window.showWarningMessage(`删除模型 ${cmd.id}？当前配置会先备份。`, {modal: true}, '删除') !== '删除') return;
          } else {
            const selected = Object.entries(cmd.variants).filter(([, v]) => !v.disabled).map(([k]) => k).join(' / ') || '使用模型默认设置';
            if (await vscode.window.showInformationMessage(`保存 ${cmd.id}？`, {modal: true, detail: `提供商：${cmd.provider}\n显示名称：${cmd.name}\n推理：${cmd.reasoning ? '是' : '否'}；图片：${cmd.images ? '是' : '否'}\n档位：${selected}\n具体请求参数请核对页面预览。保存前自动备份。`}, '保存') !== '保存') return;
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}"><title>Kilo 模型与推理设置</title></head><body>
  <header><div><h1>Kilo 模型与推理设置</h1><p>在一个页面管理自定义模型及推理选项</p></div><div class="actions"><button id="refresh" class="secondary">刷新</button><button id="restore" class="secondary">恢复备份</button><button id="reload" class="secondary">重新加载窗口</button></div></header>
  <p id="file" class="muted"></p><div id="status" role="status" aria-live="polite">正在读取配置…</div>
  <div class="layout"><aside><label for="provider">提供商</label><select id="provider"></select><label for="search">查找模型</label><input id="search" placeholder="输入 ID 或名称"><button id="add">＋ 添加模型</button><div id="list"></div></aside>
  <main><div id="empty">请选择模型，或添加新模型。请先在 Kilo 中配置提供商和 API 凭据。</div>
  <form id="form" hidden><h2 id="heading">编辑模型</h2><div class="grid"><label>模型 ID<input id="modelId" required maxlength="300"></label><label>显示名称<input id="modelName" required></label></div>
  <div class="checks"><label><input type="checkbox" id="reasoning">模型具备推理能力</label><label><input type="checkbox" id="images">支持图片</label></div>
  <section><h3>推理档位</h3><p class="muted">根据上游文档选择。此处设置客户端参数，不代表已验证模型支持。</p><div id="levels" class="checks"></div>
  <div class="actions"><button type="button" id="defaults" class="secondary">使用模型默认设置</button></div>
  <p class="hint">默认设置会禁用已配置的档位，不通过档位附加推理控制参数；是否思考由模型和上游决定。“模型具备推理能力”仅声明能力，不是思考开关。已有提供商或模型 options 参数不在此处清除。</p>
  <label for="variants">自定义选项和请求参数（JSON）</label><textarea id="variants" rows="12" spellcheck="false"></textarea><p class="muted">例如 {"low":{"reasoningEffort":"low"}}。也可使用自定义名称和 thinking 等参数。未保留的常见档位及原有档位会被禁用。</p></section>
  <section><h3>修改预览</h3><pre id="preview"></pre></section><div class="actions"><button type="submit" id="save">确认并保存</button><button type="button" id="delete" class="danger">删除模型</button></div></form></main></div>
  <script nonce="${nonce}" src="${js}"></script></body></html>`;
}
module.exports = {activate};
