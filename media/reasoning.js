'use strict';
(function(root) {
  const keys = ['reasoningEffort', 'effort', 'thinking', 'enable_thinking', 'reasoning_split', 'chat_template_args'];
  const templates = {
    thinking: {label: 'thinking.type（如 DeepSeek / GLM，需上游支持）', on: {thinking: {type: 'enabled'}}, off: {thinking: {type: 'disabled'}}},
    enable: {label: 'enable_thinking（布尔开关）', on: {enable_thinking: true}, off: {enable_thinking: false}},
    chat: {label: 'chat_template_args.enable_thinking（如部分 Qwen 服务）', on: {chat_template_args: {enable_thinking: true}}, off: {chat_template_args: {enable_thinking: false}}},
    anthropic: {label: 'Anthropic thinking（默认预算 8192，可修改）', on: {thinking: {type: 'enabled', budgetTokens: 8192}}, off: {thinking: {type: 'disabled'}}}
  };
  const active = variants => Object.fromEntries(Object.entries(variants || {}).filter(([, value]) => !value.disabled));
  const pick = options => Object.fromEntries(keys.filter(key => Object.hasOwn(options || {}, key)).map(key => [key, options[key]]));
  function mode(model) {
    const names = Object.keys(active(model?.variants));
    return names.length === 0 || (names.length === 1 && ['off', '关闭'].includes(names[0])) ? 'switch' : 'graded';
  }
  function selected(mode, variants, off) {
    return mode === 'switch' ? {'关闭': off} : variants;
  }
  const api = {keys, templates, active, pick, mode, selected};
  if (typeof module !== 'undefined') module.exports = api;
  else root.KiloReasoning = api;
})(globalThis);
