'use strict'

// 管理窗口「按软件单独设置」存的是 { exe, mode, key }。
// mode / key 为空表示跟随全局。比较进程名时忽略大小写和 .exe，与原版前端一致。
const SEND_MODES = new Set(['send', 'fill', 'copy'])
const SEND_KEYS = new Set(['enter', 'ctrl_enter', 'alt_s'])

function normalizeExeName(exe) {
  const base = String(exe ?? '').trim().split(/[\\/]/).pop() || ''
  const value = base.toLowerCase()
  return value.endsWith('.exe') ? value.slice(0, -4) : value
}

function resolveSendRule(settings, exe) {
  const send = settings && typeof settings.send === 'object' && settings.send ? settings.send : {}
  const fallbackMode = send.mode === 'fill' ? 'fill' : 'send'
  const fallbackKey = SEND_KEYS.has(send.key) ? send.key : 'enter'
  const name = normalizeExeName(exe)
  const rules = Array.isArray(send.appRules) ? send.appRules : []
  const rule = name ? rules.find((item) => item && normalizeExeName(item.exe) === name) : null
  return {
    mode: rule && (rule.mode === 'fill' || rule.mode === 'send') ? rule.mode : fallbackMode,
    key: rule && SEND_KEYS.has(rule.key) ? rule.key : fallbackKey,
    matched: !!rule,
  }
}

// 按钮明确传入 fill/send/copy 时尊重这次点击；没传才用当前窗口的默认方式。
function explicitSendMode(explicit, fallback) {
  return SEND_MODES.has(explicit) ? explicit : fallback
}

const sendRuleApi = { normalizeExeName, resolveSendRule, explicitSendMode }
if (typeof module !== 'undefined' && module.exports) module.exports = sendRuleApi
if (typeof window !== 'undefined') window.SendRule = sendRuleApi
