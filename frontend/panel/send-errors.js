'use strict'

// 共享的发送失败文案与未确认粘贴判定（面板与 electron/send.js 共用，单一数据源）。
function isUnconfirmedPaste(r) {
  if (!r || r.mediaErrors?.length) return false
  const err = String(r.error || '')
  const msg = String(r.message || '')
  if (/elevation-mismatch|activation failed/i.test(`${err} ${msg}`)) return false
  return Boolean(
    r.sendKeysOk &&
      (r.verify === 'mismatch' ||
        /paste verification mismatch|paste.*unconfirmed/i.test(err) ||
        /粘贴未确认/.test(msg)),
  )
}

function sendFailureMessage(r, fallback = '没能发到聊天窗，内容已复制，请手动粘贴') {
  if (isUnconfirmedPaste(r)) return ''
  const err = String(r?.error || '').trim()
  const msg = String(r?.message || '').trim()
  if (/elevation-mismatch/i.test(`${err} ${msg}`)) {
    return '目标聊天软件以管理员身份运行，请右键以管理员身份运行 AI客服（elevation-mismatch）'
  }
  if (/activation failed/i.test(err) || /activation failed/i.test(msg)) {
    return '没能切到聊天窗（Target activation failed），内容已复制；可点目标按钮重新「选择聊天窗…」'
  }
  if (err && msg) return `${msg}（${err}）`
  if (err) {
    return fallback.includes('（')
      ? `${fallback}（${err}）`
      : `没能发到聊天窗（${err}），内容已复制，请手动粘贴`
  }
  return msg || fallback
}

const sendErrorsApi = { isUnconfirmedPaste, sendFailureMessage }
if (typeof module !== 'undefined' && module.exports) module.exports = sendErrorsApi
if (typeof window !== 'undefined') window.SendErrors = sendErrorsApi
