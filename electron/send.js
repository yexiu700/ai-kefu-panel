'use strict'
const { clipboard } = require('electron')
const win32 = require('./win32')
const { appendSendLog } = require('./send-log')
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
// Serialize attempts: overlapping clipboard writes/restores can corrupt another paste.
let queue = Promise.resolve()
function sendPhrase(phrase, opts = {}) {
  const attempt = queue.then(async () => {
    const hasMedia = !!((phrase.images || []).length + (phrase.files || []).length)
    if (!hasMedia) return sendAttempt(String(phrase.content || ''), opts)
    const { paths, errors } = require('./media').preparePhraseMedia(phrase)
    let result
    // Text first, files last: never replace an unverified file clipboard with text.
    if (phrase.content && opts.hwnd) {
      result = await sendAttempt(String(phrase.content), { ...opts, hasMedia: true, focusInput: true })
      if (!result.ok) return { ...result, hasMedia: true }
      opts = { ...opts, hwnd: result.hwnd || opts.hwnd, exe: result.exe || opts.exe }
    }
    if (paths.length) result = await sendAttempt('', { ...opts, mediaPaths: paths, hasMedia: true })
    else result = { ok: false, hasMedia: true, verify: 'skipped', message: '没有可粘贴的媒体文件' }
    if (errors.length) {
      result = { ...result, ok: false, mediaErrors: errors, message: [result.message, ...errors].filter(Boolean).join('；') }
      try { appendSendLog({ ts: new Date().toISOString(), hasMedia: true, mediaCount: paths.length, mediaErrors: errors, verify: paths.length ? result.verify : 'skipped', verifyReason: paths.length ? '部分媒体不可用，其余项参见粘贴记录' : '全部媒体文件不可用，未粘贴媒体', ok: false }) } catch { /* The per-step logger also reports write failures. */ }
    }
    if (result.unbound && phrase.content) result.message += '；本次只复制了媒体，文字请另行复制粘贴'
    return { ...result, hasMedia: true }
  })
  queue = attempt.catch(() => {})
  return attempt
}
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
  const media = !!opts.mediaPaths?.length
  let result = { ok: false, sendKeysOk: false, method: 'sendkeys', verify: 'skipped', unbound: false }
  try {
    const prev = restoreClipboard && !media ? clipboard.readText() : null
    if (media) {
      const written = await win32.writeFileClipboard(opts.mediaPaths)
      if (!written.ok) throw new Error(written.message || '无法写入文件剪贴板，请检查文件权限或剪贴板占用')
      opts.clipboardSequence = written.clipboardSequence || 0
    } else clipboard.writeText(text)
    if (process.platform !== 'win32' || !hwnd) {
      result = { ...result, ok: true, method: 'clipboard-only', mode: 'clipboard', unbound: true }
      if (media) result.message = '图片/附件已复制，请切到聊天输入框手动粘贴'
    } else {
      const prefix = text.trim().slice(0, 24)
      result = { ...result, ...await win32.sendKeys(hwnd, { mode, key, delayMs: pasteDelayMs, prefix, exe: opts.exe, media, focusInput: opts.focusInput === true, clipboardSequence: opts.clipboardSequence || 0 }), mode }
      if (media && result.sendKeysOk) {
        result.verify = 'unavailable'
        result.verifyReason = '目标窗口没有可用的图片/附件回读接口，无法确认接收；媒体保留在剪贴板'
        if (result.ok) result.message = '已执行媒体粘贴，请核对聊天窗口；媒体仍保留在剪贴板'
      }
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
    result = { ...result, ok: false, error: String(e), message: media ? e.message : '发送失败，请从剪贴板手动粘贴' }
    if (!media) try { clipboard.writeText(text) } catch { /* Clipboard may be locked by another application. */ }
  } finally {
    try {
      appendSendLog({ ts: new Date().toISOString(), mode, key, pasteDelayMs, restoreClipboard, hwnd: result.hwnd || hwnd,
        exe: result.exe || opts.exe || null, fgBefore: result.fgBefore ?? null, fgAfter: result.fgAfter ?? null,
        elevatedTarget: result.elevatedTarget ?? null, elevatedSelf: result.elevatedSelf ?? null,
        activateAttempts: result.activateAttempts ?? 0, activateDetail: result.activateDetail || null, rebound: result.rebound === true, isWindow: result.isWindow ?? null,
        targetTitle: result.targetTitle || null, textLen: text.length, textPreview: text.slice(0, 40),
        executionOk: result.ok, pasteConfirmed: result.verify === 'match' ? true : result.verify === 'mismatch' ? false : null,
        phase: media ? 'media' : 'text', sendKeysOk: result.sendKeysOk, method: result.method, unbound: result.unbound,
        hasMedia: !!opts.hasMedia, mediaCount: opts.mediaPaths?.length || 0, verifyReason: result.verifyReason || (media ? '未执行或未确认媒体粘贴' : null),
        error: result.error || null, elapsedMs: Date.now() - started, verify: result.verify })
    } catch (e) { console.warn('[send] log write failed:', e.code || 'unknown') }
  }
  return result
}
module.exports = { sendText, sendPhrase, sleep }

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

