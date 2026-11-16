'use strict'

// 面板提示的唯一出口策略：调试/状态/成功类不弹 toast，只留给调用方写日志。
// 真正失败和必须动手处理的提示才返回 toast 文案。

function blobOf(r) {
  return `${r?.error || ''} ${r?.message || ''}`
}

function isDiagnosticSend(r) {
  if (!r) return false
  const err = String(r.error || '')
  const msg = String(r.message || '')
  const blob = blobOf(r)
  if (/elevation-mismatch|activation failed/i.test(blob)) return false
  if (/foreground-changed|clipboard-changed|input-focus-unavailable/i.test(blob)) return true
  if (r.sendKeysOk && (r.verify === 'mismatch' || r.verify === 'unavailable')) return true
  if (/paste verification mismatch|paste.*unconfirmed/i.test(err)) return true
  if (/粘贴未确认|粘贴未验证|未验证输入|已执行发送|已执行粘贴|已执行媒体粘贴|请核对聊天窗口|请核对目标输入框/.test(msg)) return true
  return false
}

function diagnosticReason(r) {
  const msg = String(r?.message || '').trim()
  const err = String(r?.error || '').trim()
  if (/foreground-changed/i.test(err)) return msg || '前台窗口发生变化，已停止自动操作'
  if (/clipboard-changed/i.test(err)) return msg || '剪贴板已被其他程序更改，已停止粘贴，请重试'
  if (/input-focus-unavailable/i.test(err)) return msg || '无法确认京东工作台输入框焦点，请先点击聊天输入框再重试'
  if (r?.verify === 'mismatch' || /paste verification mismatch|paste.*unconfirmed/i.test(err) || /粘贴未确认/.test(msg)) {
    return '粘贴未确认：回读校验未确认内容已写入输入框'
  }
  if (r?.verify === 'unavailable') return r.verifyReason || msg || '粘贴校验未能回读确认'
  if (msg) return msg
  return err || '发送诊断信息已记录'
}

function isDiagnosticCopy(message) {
  return /粘贴未确认|粘贴未验证|未验证输入|已执行发送|已填入，确认|已执行粘贴|已执行媒体粘贴|请核对聊天窗口|请核对目标输入框|前台窗口发生变化|输入框焦点|剪贴板已被其他程序更改/.test(String(message || ''))
}

function presentSendResult(r) {
  if (!r) return { toast: null, kind: 'err', log: null }
  // 没连上聊天窗时，必须告诉客服自己去粘贴。这条优先于校验诊断。
  if (r.unbound || r.mode === 'clipboard') {
    return { toast: r.message || '已复制，请在聊天窗粘贴（未连接聊天窗）', kind: 'warn', log: null }
  }
  // 媒体缺失、发送失败等具体原因不能被「校验未确认」盖掉。
  if (r.ok === false && r.message && !isDiagnosticCopy(r.message)) {
    return { toast: r.message, kind: 'err', log: null }
  }
  if (r.suppressToast || isDiagnosticSend(r)) {
    return { toast: null, kind: '', log: r.suppressedNotice || r.verifyReason || diagnosticReason(r) }
  }
  if (r.ok === false) {
    return { toast: r.message || '发送失败，请从剪贴板手动粘贴', kind: 'err', log: null }
  }
  if (r.verify && r.verify !== 'match' && r.verify !== 'skipped') {
    return { toast: null, kind: '', log: r.verifyReason || diagnosticReason(r) }
  }
  if (r.message) return { toast: null, kind: '', log: r.message }
  return { toast: null, kind: '', log: null }
}

function syncFailureToast(message) {
  const text = String(message || '').trim()
  if (!text) return '同步失败'
  return /同步失败/.test(text) ? text : `同步失败：${text}`
}

// 仍会弹给客服的提示。调试、校验状态、成功和过程提示不在这里。
const ALLOWED_TOAST_PATTERNS = [
  /发送失败/,
  /没能切到聊天窗/,
  /管理员身份运行|elevation-mismatch/,
  /保存失败/,
  /收录失败/,
  /同步失败/,
  /启动失败/,
  /加载默认公司话术失败/,
  /锁定失败/,
  /打开日志失败/,
  /^回复内容为空$/,
  /未连接聊天窗/,
  /请手动粘贴/,
  /请另行复制粘贴/,
  /请切到聊天输入框/,
  /没有可粘贴的媒体/,
  /无法粘贴/,
  /文件不存在/,
  /剪贴板被占用/,
  /无法写入文件剪贴板/,
  /文件剪贴板写入校验失败/,
]

function allowsToast(message) {
  const text = String(message || '').trim()
  if (!text) return false
  if (/粘贴未确认|粘贴未验证|未验证输入|已执行发送|已填入，确认|已执行粘贴|已执行媒体粘贴|请核对聊天窗口|请核对目标输入框|前台窗口发生变化|输入框焦点|剪贴板已被其他程序更改/.test(text)) return false
  return ALLOWED_TOAST_PATTERNS.some((re) => re.test(text))
}

const REMOVED_TOASTS = [
  '已复制',
  '已执行发送（粘贴已验证）',
  '已填入，确认后回车发送',
  '已执行发送，粘贴未验证',
  '已执行粘贴，未验证输入内容',
  '粘贴未确认成功，内容已保留在剪贴板，请手动粘贴或增加延迟',
  '已执行媒体粘贴，请核对聊天窗口；媒体仍保留在剪贴板',
  '默认公司话术已在库中',
  '已导入分组和话术（成功）',
  '这条已收录过了',
  '已收录到私人话术',
  '已锁定该窗口',
  '正在同步国内公司主库…',
  '正在同步海外公司主库…',
  '已同步公司主库（成功状态）',
  '无法确认京东工作台输入框焦点，请先点击聊天输入框再重试，或手动粘贴剪贴板中的媒体',
  '前台窗口发生变化，已停止粘贴，请重新选择聊天窗',
  '剪贴板已被其他程序更改，已停止粘贴，请重试',
  '粘贴后前台窗口发生变化，已停止按发送键，请核对目标输入框',
]

const api = {
  isDiagnosticSend,
  diagnosticReason,
  presentSendResult,
  syncFailureToast,
  allowsToast,
  ALLOWED_TOAST_PATTERNS,
  REMOVED_TOASTS,
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
globalThis.AiKefuNotice = api
