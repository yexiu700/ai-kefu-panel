'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const notice = require('../frontend/panel/notice')

function splitTop(args) {
  const parts = []
  let depth = 0, quote = '', cur = ''
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (quote) {
      cur += c
      if (c === '\\') { cur += args[++i] || ''; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; cur += c; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function toastArgs(file) {
  const src = fs.readFileSync(file, 'utf8')
  const found = []
  let i = 0
  while ((i = src.indexOf('toast(', i)) !== -1) {
    const before = src.slice(Math.max(0, i - 12), i)
    if (/function\s+$/.test(before)) { i += 6; continue }
    let j = i + 6, depth = 1, quote = ''
    while (j < src.length && depth) {
      const c = src[j]
      if (quote) {
        if (c === '\\') { j += 2; continue }
        if (c === quote) quote = ''
      } else if (c === '\'' || c === '"' || c === '`') quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
      j++
    }
    const first = splitTop(src.slice(i + 6, j - 1))[0]
    const line = src.slice(0, i).split(/\n/).length
    found.push({ file, line, first })
    i = j
  }
  return found
}

function managerToastMessages(file) {
  const src = fs.readFileSync(file, 'utf8')
  const out = []
  const re = /toasts\.(success|error|warning|info|warn)\(\s*(`(?:\\`|[^`])*`|"(?:\\"|[^"])*"|'(?:\\'|[^'])*')/g
  let m
  while ((m = re.exec(src))) out.push({ kind: m[1], message: m[2].slice(1, -1), file })
  return out
}

function loadSend(logs, responseBox) {
  const filename = path.resolve('electron/send.js')
  const real = createRequire(filename)
  let clip = 'original'
  const sandbox = {
    module: { exports: {} },
    require: id => {
      if (id === 'electron') return { clipboard: { readText: () => clip, writeText: value => { clip = value } } }
      if (id === './send-log') return { appendSendLog: value => logs.push(value) }
      if (id === './win32') return { sendKeys: async () => responseBox.response, writeFileClipboard: async () => ({ ok: true }) }
      if (id === '../frontend/panel/notice') return notice
      return real(id)
    },
    process: { platform: 'win32' },
    console,
    setTimeout,
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return { sender: sandbox.module.exports, readClip: () => clip, setClip: value => { clip = value } }
}

const ALLOWED_ARGS = [
  /^'已复制，请在聊天窗粘贴（未连接聊天窗）'$/,
  /^view\.toast$/,
  /^'发送失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'发送失败，已复制：' \+ \(e\?\.message \|\| e\)$/,
  /^'保存失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'设置保存失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'加载默认公司话术失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'收录失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'锁定失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'打开日志失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'同步失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'启动失败：' \+ \(e\?\.message \|\| e\)$/,
  /^'回复内容为空'$/,
  /^globalThis\.AiKefuNotice\.syncFailureToast\(result\?\.message\)$/,
]

const FORBIDDEN_IN_TOAST = [
  '粘贴未确认',
  '粘贴未验证',
  '未验证输入',
  '粘贴已验证',
  '已执行发送',
  '已填入，确认',
  '已执行粘贴',
  '已执行媒体粘贴',
  '请核对聊天窗口',
  '请核对目标输入框',
  '已锁定该窗口',
  '正在同步',
  '默认公司话术已在库中',
  '这条已收录过了',
  '已收录到私人话术',
  '前台窗口发生变化',
  '输入框焦点',
  '剪贴板已被其他程序更改',
  '请重试',
]

function assertNoToast(result, label) {
  const view = notice.presentSendResult(result)
  assert.equal(view.toast, null, label + ' must not toast, got ' + view.toast)
  assert.ok(view.log, label + ' must keep a log line')
  return view
}

async function main() {
  const sites = toastArgs('frontend/panel/panel.js')
  assert.ok(sites.length >= 10, 'panel toast call sites were not found')
  console.log('panel toast call sites:')
  for (const site of sites) {
    const ok = ALLOWED_ARGS.some(re => re.test(site.first))
    console.log(`  ${site.line}: ${site.first}`)
    assert.ok(ok, `toast at panel.js:${site.line} is not an allowed failure/must-act notice: ${site.first}`)
    for (const phrase of FORBIDDEN_IN_TOAST) assert.ok(!site.first.includes(phrase), phrase)
  }
  const panel = fs.readFileSync('frontend/panel/panel.js', 'utf8')
  for (const phrase of FORBIDDEN_IN_TOAST) {
    assert.ok(!sites.some(site => site.first.includes(phrase)), phrase + ' is still a toast argument')
  }
  assert.ok(panel.includes("logNotice('已复制')"), 'connected copy is logged')
  assert.ok(panel.includes("logNotice('已锁定该窗口')"), 'lock success is logged')
  assert.ok(panel.includes('logNotice(`正在同步'), 'sync progress is logged')
  assert.ok(!panel.includes('粘贴未确认成功'), 'old unconfirmed toast copy is gone')
  assert.ok(!panel.includes('已执行发送'), 'success/unverified send toasts are gone')

  const managerFiles = [
    'frontend/assets/manager-DBuMfWSZ.js',
    'frontend/assets/index-CXzEw6Jt.js',
    'frontend/assets/TemplatesPage-BlVodupk.js',
    'frontend/assets/GuideSpotlight-Bc_qirTp.js',
  ]
  const managerToasts = managerFiles.flatMap(managerToastMessages)
  assert.ok(managerToasts.length > 0, 'manager toast audit found no call sites')
  for (const item of managerToasts) {
    for (const phrase of FORBIDDEN_IN_TOAST) {
      assert.ok(!item.message.includes(phrase), `${item.file} still toasts diagnostic text: ${item.message}`)
    }
  }
  console.log(`manager/legacy toast messages audited: ${managerToasts.length}, none are send diagnostics`)

  const sendSrc = fs.readFileSync('electron/send.js', 'utf8')
  assert.ok(!sendSrc.includes('粘贴未确认成功'), 'send.js must not build the unconfirmed toast')
  assert.ok(!sendSrc.includes('已执行媒体粘贴，请核对'), 'media verify status must not be a toast message')

  const logs = []
  const box = { response: {} }
  const { sender, readClip, setClip } = loadSend(logs, box)

  box.response = { ok: false, verify: 'mismatch', sendKeysOk: true, error: 'Paste verification mismatch' }
  setClip('original')
  const unconfirmed = await sender.sendText('待发送的话术', { hwnd: 7 })
  const unconfirmedView = assertNoToast(unconfirmed, 'paste mismatch')
  assert.equal(unconfirmed.suppressToast, true)
  assert.equal(unconfirmed.message, undefined)
  assert.equal(readClip(), '待发送的话术')
  assert.equal(logs.at(-1).verify, 'mismatch')
  assert.match(logs.at(-1).verifyReason, /粘贴未确认/)
  assert.match(unconfirmedView.log, /粘贴未确认/)
  assert.equal(logs.at(-1).suppressedNotice, logs.at(-1).verifyReason)

  box.response = { ok: false, verify: 'unavailable', sendKeysOk: true, error: 'paste unconfirmed' }
  const unconfirmedErr = await sender.sendText('另一条', { hwnd: 7 })
  assertNoToast(unconfirmedErr, 'paste unconfirmed error')
  assert.match(logs.at(-1).verifyReason, /粘贴未确认/)

  box.response = { ok: true, verify: 'unavailable', sendKeysOk: true }
  const unread = await sender.sendText('回读不到', { hwnd: 7, restoreClipboard: false })
  assertNoToast(unread, 'verify unavailable')
  assert.match(logs.at(-1).verifyReason, /未确认|未能回读/)
  assert.equal(logs.at(-1).verify, 'unavailable')

  box.response = { ok: true, verify: 'match', sendKeysOk: true }
  const matched = await sender.sendText('已确认', { hwnd: 7, restoreClipboard: false })
  assert.equal(notice.presentSendResult(matched).toast, null, 'verified success stays silent')
  assert.equal(logs.at(-1).verify, 'match')

  for (const diagnostic of [
    { ok: false, sendKeysOk: true, verify: 'match', error: 'foreground-changed', message: '粘贴后前台窗口发生变化，已停止按发送键，请核对目标输入框' },
    { ok: false, sendKeysOk: false, error: 'foreground-changed', message: '前台窗口发生变化，已停止粘贴，请重新选择聊天窗' },
    { ok: false, sendKeysOk: false, error: 'input-focus-unavailable', message: '无法确认京东工作台输入框焦点，请先点击聊天输入框再重试，或手动粘贴剪贴板中的媒体' },
    { ok: false, sendKeysOk: false, error: 'clipboard-changed', message: '剪贴板已被其他程序更改，已停止粘贴，请重试' },
  ]) {
    box.response = diagnostic
    const result = await sender.sendText('诊断', { hwnd: 7, restoreClipboard: false })
    const view = assertNoToast(result, diagnostic.error)
    assert.match(logs.at(-1).suppressedNotice, new RegExp(diagnostic.message.slice(0, 8).replace(/[()]/g, '')))
    assert.equal(view.toast, null)
  }

  box.response = { ok: false, sendKeysOk: false, error: 'Target activation failed' }
  const missed = await sender.sendText('没切过去', { hwnd: 7 })
  const missedView = notice.presentSendResult(missed)
  assert.match(missedView.toast, /没能切到聊天窗/)
  assert.equal(notice.allowsToast(missedView.toast), true)
  assert.match(logs.at(-1).error, /activation failed/)

  box.response = { ok: false, sendKeysOk: false, error: 'elevation-mismatch' }
  const elevated = await sender.sendText('权限', { hwnd: 7 })
  assert.match(notice.presentSendResult(elevated).toast, /管理员身份运行/)
  assert.match(notice.presentSendResult(elevated).toast, /elevation-mismatch/)

  const unbound = await sender.sendText('手动', {})
  assert.equal(unbound.unbound, true)
  assert.match(notice.presentSendResult(unbound).toast, /未连接聊天窗|请手动粘贴|请切到聊天输入框/)
  assert.equal(logs.at(-1).verify, 'skipped')

  const logs2 = []
  const filename = path.resolve('electron/send.js')
  const real = createRequire(filename)
  const sandbox = {
    module: { exports: {} },
    require: id => {
      if (id === 'electron') return { clipboard: { readText: () => '', writeText() {} } }
      if (id === './send-log') return { appendSendLog: value => logs2.push(value) }
      if (id === './win32') return { sendKeys: async () => { throw new Error('sendkeys exploded') } }
      if (id === '../frontend/panel/notice') return notice
      return real(id)
    },
    process: { platform: 'win32' }, console, setTimeout,
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  const failed = await sandbox.module.exports.sendText('炸了', { hwnd: 3 })
  assert.match(notice.presentSendResult(failed).toast, /发送失败/)
  assert.equal(logs2.length, 1)
  assert.equal(notice.allowsToast('回复内容为空'), true)
  assert.equal(notice.allowsToast('已执行发送，粘贴未验证'), false)
  assert.equal(notice.allowsToast('粘贴未确认成功，内容已保留在剪贴板，请手动粘贴或增加延迟'), false)
  assert.match(notice.syncFailureToast('飞书表没有公司话术'), /^同步失败：/)
  assert.equal(notice.syncFailureToast('同步失败：网络断开'), '同步失败：网络断开')

  for (const removed of notice.REMOVED_TOASTS) {
    assert.equal(notice.allowsToast(removed), false, removed)
  }
  console.log('PASS: diagnostic toasts suppressed and logged; failure and must-act notices remain')
}

main().catch(e => { console.error(e); process.exitCode = 1 })
