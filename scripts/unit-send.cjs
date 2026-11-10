'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
function load(file, mocks) {
  const filename = path.resolve(file), real = createRequire(filename)
  const sandbox = { module: { exports: {} }, require: id => id in mocks ? mocks[id] : real(id), process: { platform: 'win32' }, console, setTimeout }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return sandbox.module.exports
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-026-'))
  const electron = { app: { getPath: () => dir } }
  const store = load('electron/store.js', { electron })
  const settings = store.normalizeSettings(store.deepMerge(store.defaultSettings(), { send: { pasteDelayMs: 500, restoreClipboard: false } }))
  assert.equal(settings.send.pasteDelayMs, 500)
  assert.equal(settings.send.restoreClipboard, false)
  assert.equal(settings.send.key, 'enter')
  const logger = load('electron/send-log.js', { electron })
  const file = logger.appendSendLog({ verify: 'unavailable', textLen: 3 }, dir)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).verify, 'unavailable')
  let clip = 'original', response = {}, logs = [], calls = []
  const sender = load('electron/send.js', {
    electron: { clipboard: { readText: () => clip, writeText: value => { clip = value } } },
    './send-log': { appendSendLog: value => logs.push(value) },
    './win32': { sendKeys: async (_, opts) => { calls.push(opts); return response } },
  })
  response = { ok: false, verify: 'mismatch', sendKeysOk: true }
  assert.equal((await sender.sendText('phrase', { hwnd: 1 })).ok, false)
  assert.equal(clip, 'phrase')
  assert.equal(logs[0].verify, 'mismatch')
  assert.equal(logs[0].pasteDelayMs, 80)
  response = { ok: true, verify: 'match', sendKeysOk: true }
  clip = 'original'
  await sender.sendText('phrase', { hwnd: 1, pasteDelayMs: 0 })
  assert.equal(clip, 'original')
  await sender.sendText('leave', { hwnd: 1, restoreClipboard: false })
  assert.equal(clip, 'leave')
  assert.equal(calls.at(-1).prefix, 'leave')
  const unbound = await sender.sendText('manual')
  assert.equal(unbound.unbound, true)
  assert.equal(logs.at(-1).verify, 'skipped')
  assert.equal(logs.length, 4)
  const upgraded = store.normalizeSettings({ panel: { chatApps: ['custom.exe', 'JDM_DD_WORKBENCH.EXE'] } })
  assert.ok(upgraded.panel.chatApps.includes('custom.exe'))
  assert.ok(upgraded.panel.chatApps.includes('pop_dd_workbench.exe'))
  assert.equal(upgraded.panel.chatApps.filter(x => x.toLowerCase() === 'jdm_dd_workbench.exe').length, 1)
  response = { ok: false, sendKeysOk: false, error: 'Target activation failed', targetTitle: '咚咚工作台', exe: 'pop_dd_workbench.exe', fgBefore: 2, fgAfter: 2, elevatedTarget: true, elevatedSelf: true, activateAttempts: 3, isWindow: true }
  const failed = await sender.sendText('test', { hwnd: 1 })
  assert.ok(failed.message.includes('Target activation failed') && failed.message.includes('选择聊天窗'))
  assert.ok(!failed.message.includes('延迟'))
  assert.equal(logs.at(-1).targetTitle, response.targetTitle)
  for (const k of ['exe', 'fgBefore', 'fgAfter', 'elevatedTarget', 'elevatedSelf', 'activateAttempts', 'error']) assert.equal(logs.at(-1)[k], response[k])
  response = { ...response, error: 'elevation-mismatch' }
  const elevMsg = (await sender.sendText('test', { hwnd: 1 })).message
  assert.ok(elevMsg.includes('elevation-mismatch') && elevMsg.includes('管理员'))
  response = { ok: true, sendKeysOk: true, rebound: true, hwnd: 99, verify: 'unavailable' }
  let rebound
  await sender.sendText('test', { hwnd: 1, restoreClipboard: false, onRebound: r => { rebound = r.hwnd } })
  assert.equal(rebound, 99)
  assert.equal(logs.at(-1).hwnd, 99)
  assert.equal(logs.at(-1).rebound, true)
  console.log('PASS: settings merge, JSONL writer, mismatch preservation, restore, no-restore, unbound logging')
}
main().catch(e => { console.error(e); process.exitCode = 1 })


