'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const {spawn} = require('node:child_process');
function local(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || /^(fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host) || /^(127|10)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
function domestic(host) { return /\.cn$|(^|\.)(bigmodel\.cn|deepseek\.com|aliyuncs\.com|volces\.com|moonshot\.ai|moonshot\.cn|siliconflow\.cn|baidubce\.com|tencentcloudapi\.com)$/.test(host); }
async function reachable(port = 7897) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(400); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
async function useProxy(host) {
  if (local(host) || domestic(host)) return false;
  const addresses = await Promise.race([dns.lookup(host, {all: true}).catch(() => []), new Promise(resolve => { const timer = setTimeout(() => resolve([]), 800); timer.unref(); })]);
  if (addresses.some(address => local(address.address))) return false;
  return reachable();
}
function expand(value, env = process.env) {
  return String(value).replace(/\{env:([^}]+)\}/g, (_, key) => {
    if (!env[key]) throw Error(`环境变量 ${key} 未设置。`);
    return env[key];
  });
}
function connection(provider, id, auth = {}, env = process.env) {
  const url = new URL(expand(provider.options?.baseURL || '', env));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw Error('供应商 API 地址不合法，请编辑连接信息。');
  const envKey = (provider.env || []).map(name => env[name]).find(Boolean);
  const key = expand(provider.options?.apiKey || (auth[id]?.type === 'api' ? auth[id].key : '') || envKey || '', env);
  const headers = {Accept: 'application/json'};
  if (provider.npm === '@ai-sdk/anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (key) headers.Authorization = 'Bearer ' + key;
  for (const [name, value] of Object.entries(provider.options?.headers || {})) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) throw Error('供应商请求头名称不合法。');
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    headers[name] = expand(value, env);
  }
  if (Object.values(headers).some(value => /[\r\n\0]/.test(value))) throw Error('供应商凭据或请求头包含非法字符。');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/models';
  return {url, headers};
}
function curl(url, headers, proxy, timeoutSeconds = 25) {
  const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return new Promise((resolve, reject) => {
    // Headers go through stdin, not command-line arguments or logs. Never follow redirects.
    const args = ['--disable', '--silent', '--show-error', '--connect-timeout', '5', '--max-time', String(timeoutSeconds), '--max-filesize', '4194304', '--proto', '=http,https', '--proxy', proxy ? 'http://127.0.0.1:7897' : '', '--noproxy', proxy ? '' : '*', '--write-out', '\n%{http_code}', '--config', '-', url.toString()];
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = []; let length = 0, overflow = false;
    const timer = setTimeout(() => child.kill(), timeoutSeconds * 1000 + 3000);
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 4200000) { overflow = true; child.kill(); } else chunks.push(chunk); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(Error('无法启动 curl，请确认系统已安装 curl。')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (overflow) return reject(Error('模型列表超过 4 MB，已停止读取。'));
      if (code !== 0) return reject(Object.assign(Error(`读取模型列表的网络请求失败（curl ${code ?? 'timeout'}）。`), {network: [5, 6, 7, 28, 35, 51, 52, 55, 56, 60, 97, null].includes(code)}));
      const text = Buffer.concat(chunks).toString('utf8'), split = text.lastIndexOf('\n');
      const status = Number(text.slice(split + 1));
      if (status < 200 || status >= 300) return reject(Error(`读取模型列表失败（HTTP ${status}）。${[401, 403].includes(status) ? '请检查 API Key 和权限。' : status === 404 ? '请检查 API 地址是否包含正确的版本路径（如 /v1）。' : ''}`));
      try { resolve(JSON.parse(text.slice(0, split))); } catch { reject(Error('供应商返回的模型列表不是有效 JSON。')); }
    });
    child.stdin.end(Object.entries(headers).map(([name, value]) => 'header = ' + quote(name + ': ' + value)).join('\n') + '\n');
  });
}
function normalize(data) {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : null;
  if (!list) throw Error('供应商未返回可识别的模型列表（需要 data 或 models 数组）。');
  const result = new Map();
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 300) continue;
    const name = item?.display_name || item?.name || id;
    result.set(id, {id, name: typeof name === 'string' ? name.slice(0, 300) : id});
    if (result.size > 2000) throw Error('模型列表超过 2000 个，请缩小供应商返回范围。');
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', {numeric: true}));
}
async function fetchModels(provider, id, dependencies = {}) {
  let auth = dependencies.auth;
  if (!auth) {
    try { auth = JSON.parse(fs.readFileSync(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'kilo/auth.json'), 'utf8')); }
    catch { auth = {}; }
  }
  const {url, headers} = connection(provider, id, auth, dependencies.env);
  const proxy = await (dependencies.useProxy || useProxy)(url.hostname);
  const request = dependencies.request || curl;
  const deadline = Date.now() + 45000, result = new Map(), cursors = new Set();
  if (provider.npm === '@ai-sdk/anthropic') url.searchParams.set('limit', '1000');
  for (let page = 0; page < 20; page++) {
    const timeout = () => { const remaining = Math.floor((deadline - Date.now()) / 1000); if (remaining < 1) throw Error('模型列表读取超时，请重试。'); return Math.min(25, remaining); };
    let data;
    try { data = await request(url, headers, proxy, timeout()); }
    catch (error) { if (!proxy || !error.network) throw error; data = await request(url, headers, false, timeout()); }
    for (const model of normalize(data)) result.set(model.id, model);
    if (result.size > 2000) throw Error('模型列表超过 2000 个，请缩小供应商返回范围。');
    if (data?.has_more !== true) return [...result.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', {numeric: true}));
    const cursor = data.last_id || data.data?.at(-1)?.id;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw Error('供应商模型分页游标无效，未导入不完整的列表。');
    cursors.add(cursor); url.searchParams.set('after_id', cursor);
  }
  throw Error('供应商模型分页过多，未导入不完整的列表。');
}
module.exports = {local, domestic, connection, normalize, fetchModels, curl};
