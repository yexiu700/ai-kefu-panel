'use strict'
const { clipboard } = require('electron')
const win32 = require('./win32')
const { appendSendLog } = require('./send-log')
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
// Serialize attempts: overlapping clipboard writes/restores can corrupt another paste.
let queue = Promise.resolve()
function sendText(text, opts = {}) {
  const attempt = queue.then(() => sendAttempt(String(text ?? ''), opts))
  queue = attempt.catch(() => {})
  return attempt
}
async function sendAttempt(text, opts) {
  const started = Date.now()
  const mode = opts.mode || 'send'
  const key = opts.key || 'enter'
  const pasteDelayMs = Number.isFinite(Number(opts.pasteDelayMs)) ? Math.max(0, Math.min(10000, Number(opts.pasteDelayMs))) : 80
  const restoreClipboard = opts.restoreClipboard !== false
  const hwnd = Number(opts.hwnd) || 0
  let result = { ok: false, sendKeysOk: false, method: 'sendkeys', verify: 'skipped', unbound: false }
  try {
    const prev = restoreClipboard ? clipboard.readText() : null
    clipboard.writeText(text)
    if (process.platform !== 'win32' || !hwnd) {
      result = { ...result, ok: true, method: 'clipboard-only', mode: 'clipboard', unbound: true }
    } else {
      const prefix = text.trim().slice(0, 24)
      result = { ...result, ...await win32.sendKeys(hwnd, { mode, key, delayMs: pasteDelayMs, prefix, exe: opts.exe }), mode }
      result.sendKeysOk = result.sendKeysOk === true
      if (result.rebound && result.hwnd) opts.onRebound?.(result)
      if (!result.ok) {
        result.message = failureMessage(result)
      } else if (restoreClipboard && prev !== null) {
        // The daemon already waited and verified; keep an additional restore grace period.
        await sleep(Math.max(150, pasteDelayMs))
        clipboard.writeText(prev)
      }
      if (opts.intervalMs > 0) await sleep(opts.intervalMs)
    }
  } catch (e) {
    result = { ...result, ok: false, error: String(e), message: '发送失败，请从剪贴板手动粘贴' }
    try { clipboard.writeText(text) } catch { /* Clipboard may be locked by another application. */ }
  } finally {
    try {
      appendSendLog({ ts: new Date().toISOString(), mode, key, pasteDelayMs, restoreClipboard, hwnd: result.hwnd || hwnd,
        exe: result.exe || opts.exe || null, fgBefore: result.fgBefore ?? null, fgAfter: result.fgAfter ?? null,
        elevatedTarget: result.elevatedTarget ?? null, elevatedSelf: result.elevatedSelf ?? null,
        activateAttempts: result.activateAttempts ?? 0, activateDetail: result.activateDetail || null, rebound: result.rebound === true, isWindow: result.isWindow ?? null,
        targetTitle: result.targetTitle || null, textLen: text.length, textPreview: text.slice(0, 40),
        sendKeysOk: result.sendKeysOk, method: result.method, unbound: result.unbound,
        error: result.error || null, elapsedMs: Date.now() - started, verify: result.verify })
    } catch (e) { console.warn('[send] log write failed:', e.code || 'unknown') }
  }
  return result
}
module.exports = { sendText, sleep }

function failureMessage(r) {
  const err = String(r.error || '').trim()
  if (/elevation-mismatch/i.test(`${err} ${r.message || ''}`)) {
    return '京东工作台以管理员运行，请右键以管理员身份运行 AI客服（elevation-mismatch）'
  }
  if (/activation failed/i.test(err)) {
    return '没能切到聊天窗（Target activation failed），内容已复制；可点目标按钮重新「选择聊天窗…」'
  }
  if (r.sendKeysOk && (r.verify === 'mismatch' || /paste.*unconfirmed/i.test(err))) {
    return '粘贴未确认成功，内容已保留在剪贴板，请手动粘贴或增加延迟'
  }
  if (err) return `${r.message || '发送失败，内容已保留在剪贴板，请手动粘贴'}（${err}）`
  return r.message || '发送失败，内容已保留在剪贴板，请手动粘贴'
}

