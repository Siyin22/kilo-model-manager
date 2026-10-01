'use strict';
const vscode = require('vscode');
const patcher = require('./patcher');
function activate(context) {
  if (vscode.extensions.getExtension('local-tools.kilo-picker-helper')) {
    vscode.window.showWarningMessage('Kilo模型工具箱已整合分组助手。请卸载或禁用旧版 Kilo 模型分组助手并重新加载窗口，以启用工具箱的分组与保存修复功能。');
    return;
  }
  const output = vscode.window.createOutputChannel('Kilo模型工具箱');
  context.subscriptions.push(output);
  const storage = context.globalStorageUri.fsPath;
  let queue = Promise.resolve();
  let restoring = false;
  function target() {
    const extension = vscode.extensions.getExtension('kilocode.kilo-code');
    if (!extension) throw Error('未找到当前 VS Code 中安装的 Kilo Code。');
    return extension.extensionPath;
  }
  const config = () => vscode.workspace.getConfiguration('kiloPicker');
  async function run(restore = false, quiet = false) {
    try {
      if (restore) {
        restoring = true;
        await config().update('autoApply', false, vscode.ConfigurationTarget.Global);
      }
      const settings = config();
      const result = patcher.apply(target(), storage, {
        hideGateway: !restore && settings.get('hideGateway', true),
        disableMostUsed: !restore && settings.get('disableMostUsed', true),
        fixNativeSave: !restore && settings.get('fixNativeSave', true)
      });
      const message = `${restore ? '已恢复原版' : '已应用分组与保存修复设置'}（Kilo ${result.version}）`;
      output.appendLine(new Date().toISOString() + ' ' + message);
      if (result.changed) {
        vscode.window.showInformationMessage(message + '，重新加载窗口后生效。', '重新加载窗口')
          .then(choice => { if (choice) return vscode.commands.executeCommand('workbench.action.reloadWindow'); });
      } else if (!quiet) vscode.window.showInformationMessage(message + '，文件无需变更。');
    } catch (error) {
      output.appendLine(error.stack || String(error));
      vscode.window.showWarningMessage('Kilo模型工具箱：' + error.message);
    } finally { restoring = false; }
  }
  function schedule(restore, quiet) {
    queue = queue.then(() => run(restore, quiet));
    return queue;
  }
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('kiloPicker.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-tools.kilo-model-manager-local'));
  register('kiloPicker.apply', () => schedule(false, false));
  register('kiloPicker.restore', () => schedule(true, false));
  register('kiloPicker.status', () => {
    output.appendLine(`备份目录：${storage}\n自动应用：${config().get('autoApply')}`);
    try {
      const state = patcher.inspect(target(), storage);
      output.appendLine(`Kilo ${state.version}：${target()}`);
      for (const file of state.files) output.appendLine(`${file.name}：隐藏 Gateway=${file.options.hideGateway}，禁用最常用=${file.options.disableMostUsed}，修复原生保存=${file.options.fixNativeSave}`);
    } catch (error) { output.appendLine(error.message); }
    output.show();
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!restoring && event.affectsConfiguration('kiloPicker') && config().get('autoApply')) schedule(false, true);
  }));
  context.subscriptions.push(vscode.extensions.onDidChange(() => {
    if (config().get('autoApply')) schedule(false, true);
  }));
  if (config().get('autoApply')) schedule(false, true);
}
module.exports = {activate};
