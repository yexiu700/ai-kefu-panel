'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { resolveSendRule, explicitSendMode, normalizeExeName } = require('../frontend/panel/send-rule')

const settings = {
  send: {
    mode: 'send',
    key: 'enter',
    pasteDelayMs: 90,
    restoreClipboard: true,
    intervalMs: 400,
    appRules: [
      { exe: 'JingMai.exe', mode: null, key: 'ctrl_enter' },
      { exe: 'weixin.exe', mode: 'fill', key: null },
      { exe: '紫鸟浏览器.exe', mode: 'fill', key: 'alt_s' },
      { exe: 'qq.exe', mode: 'send', key: 'ctrl_enter' },
    ],
  },
}

assert.equal(normalizeExeName('  JingMai.EXE  '), 'jingmai')
assert.equal(normalizeExeName('紫鸟浏览器'), '紫鸟浏览器')
assert.deepEqual(resolveSendRule(settings, 'jingmai.exe'), { mode: 'send', key: 'ctrl_enter', matched: true })
assert.deepEqual(resolveSendRule(settings, 'WeChat.exe'), { mode: 'send', key: 'enter', matched: false })
assert.deepEqual(resolveSendRule(settings, 'Weixin.EXE'), { mode: 'fill', key: 'enter', matched: true })
assert.deepEqual(resolveSendRule(settings, '紫鸟浏览器.exe'), { mode: 'fill', key: 'alt_s', matched: true })
// 短名字不能吃掉更长的进程名，否则 qq 会套到 QQ 浏览器上。
assert.deepEqual(resolveSendRule(settings, 'QQBrowser.exe'), { mode: 'send', key: 'enter', matched: false })
assert.deepEqual(resolveSendRule(settings, '紫鸟.exe'), { mode: 'send', key: 'enter', matched: false })
assert.deepEqual(resolveSendRule(settings, 'chrome.exe'), { mode: 'send', key: 'enter', matched: false })
assert.deepEqual(resolveSendRule(settings, ''), { mode: 'send', key: 'enter', matched: false })
assert.equal(resolveSendRule(settings, 'JingMai.exe').mode, 'send', '空的单独发送方式跟随全局')

const weird = resolveSendRule({
  send: { mode: 'fill', key: 'alt_s', appRules: [{ exe: 'tim.exe', mode: 'nope', key: 'shift_enter' }] },
}, 'tim.exe')
assert.deepEqual(weird, { mode: 'fill', key: 'alt_s', matched: true })
assert.equal(resolveSendRule({ send: { mode: 'nope', key: 'shift_enter' } }, 'chrome.exe').key, 'enter')
assert.equal(resolveSendRule(null, 'chrome.exe').mode, 'send')
assert.equal(explicitSendMode('fill', 'send'), 'fill')
assert.equal(explicitSendMode('copy', 'send'), 'copy')
assert.equal(explicitSendMode(undefined, 'fill'), 'fill')
assert.equal(explicitSendMode('SEND', 'fill'), 'fill')
const frozen = structuredClone(settings)
resolveSendRule(settings, 'JingMai.exe')
assert.deepEqual(settings, frozen)

function load(file, mocks) {
  const filename = path.resolve(file)
  const real = createRequire(filename)
  const sandbox = {
    module: { exports: {} },
    require: (id) => (id in mocks ? mocks[id] : real(id)),
    console, process, Buffer,
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return sandbox.module.exports
}

async function main() {
  let phraseSent = null
  let textSent = null
  const electron = {
    app: {}, dialog: {}, shell: {}, clipboard: {},
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: {},
  }
  const handlers = load('electron/handlers.js', {
    electron,
    './store': {
      loadLibrary: () => ({ groups: [{ phrases: [{ id: 'p1', title: '问候', content: '你好' }] }] }),
      loadSettings: () => settings,
    },
    './media': {},
    './send': {
      sendPhrase: async (phrase, opts) => { phraseSent = { phrase, opts }; return { ok: true } },
      sendText: async (text, opts) => { textSent = { text, opts }; return { ok: true } },
    },
    './send-log': {},
    './win32': {},
    './assist': { getAssistState: () => ({ result: { reply: '建议回复' } }) },
    './feishu-sync': {},
    './feishu-config': {},
  })

  handlers.runtime.target = { hwnd: 42, exe: 'JingMai.exe', title: '京麦接待' }
  await handlers.handleCommand('send_phrase', { phraseId: 'p1', mode: 'send' })
  assert.equal(phraseSent.opts.key, 'ctrl_enter')
  assert.equal(phraseSent.opts.mode, 'send', '点「发送」仍发送，只换按键')
  assert.equal(phraseSent.opts.hwnd, 42)
  assert.equal(phraseSent.opts.pasteDelayMs, 90)
  assert.equal(phraseSent.opts.intervalMs, 400)
  assert.equal(phraseSent.opts.exe, 'JingMai.exe')

  await handlers.handleCommand('send_phrase', { phraseId: 'p1' })
  assert.equal(phraseSent.opts.mode, 'send')
  assert.equal(phraseSent.opts.key, 'ctrl_enter')

  await handlers.handleCommand('send_phrase', { phraseId: 'p1', mode: 'fill' })
  assert.equal(phraseSent.opts.mode, 'fill')
  assert.equal(phraseSent.opts.key, 'ctrl_enter')

  handlers.runtime.target = { hwnd: 7, exe: 'Weixin.exe', title: '微信' }
  await handlers.handleCommand('send_phrase', { phraseId: 'p1' })
  assert.equal(phraseSent.opts.mode, 'fill')
  assert.equal(phraseSent.opts.key, 'enter')
  assert.equal(phraseSent.opts.restoreClipboard, true)

  handlers.runtime.target = null
  await handlers.handleCommand('assist_send', { text: 'hello' })
  assert.equal(textSent.opts.key, 'enter')
  assert.equal(textSent.opts.mode, 'send')
  assert.equal(textSent.opts.restoreClipboard, false)
  assert.equal(textSent.text, 'hello')

  handlers.runtime.target = { hwnd: 9, exe: '紫鸟浏览器.exe' }
  const empty = await handlers.handleCommand('assist_send', { text: '' })
  assert.equal(empty.ok, false)
  assert.equal(empty.mode, 'fill')
  await handlers.handleCommand('assist_send', {})
  assert.equal(textSent.opts.key, 'alt_s')
  assert.equal(textSent.opts.mode, 'fill')
  assert.equal(textSent.text, '建议回复')

  const html = fs.readFileSync('frontend/index.html', 'utf8')
  const panel = fs.readFileSync('frontend/panel/panel.js', 'utf8')
  assert.ok(html.indexOf('/panel/send-rule.js') < html.indexOf('/panel/panel.js'))
  assert.ok(panel.includes('window.SendRule?.resolveSendRule?.(S.settings, S.target?.exe)'))
  assert.ok(panel.includes('prevExe.toLowerCase() !== String(t?.exe || \'\').toLowerCase()'))
  assert.ok(!panel.includes("toast('已发送") && !panel.includes("toast('发送成功"))

  const browser = { window: {} }
  vm.runInNewContext(fs.readFileSync('frontend/panel/send-rule.js', 'utf8'), browser, { filename: 'send-rule.js' })
  assert.equal(browser.window.SendRule.resolveSendRule(settings, 'QQ.exe').key, 'ctrl_enter')
  console.log('unit-send-rule: ok (per-app key/mode, explicit click, assist, panel wiring)')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
