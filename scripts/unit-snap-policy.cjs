'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pollPolicy } = require('../electron/snap-policy')
const defaults = { docked: true, visible: true, autoBind: true, pinned: false, now: 280, lastForegroundPoll: 0 }
assert.equal(pollPolicy(defaults).shouldPollForeground, true)
assert.equal(pollPolicy({ ...defaults, now: 279 }).shouldPollForeground, false)
for (const change of [{ docked: false }, { visible: false }]) {
  const sleeping = pollPolicy({ ...defaults, ...change })
  assert.equal(sleeping.shouldSnap, false)
  assert.equal(sleeping.shouldRefreshRect, false)
  assert.equal(sleeping.shouldPollForeground, false)
  assert.equal(sleeping.foregroundIntervalMs, 1000)
  assert.equal(pollPolicy({ ...defaults, ...change, now: 1000 }).shouldPollForeground, true)
}
assert.equal(pollPolicy({ ...defaults, autoBind: false }).shouldPollForeground, false)
assert.equal(pollPolicy({ ...defaults, pinned: true }).shouldPollForeground, false)

async function main() {
  let tick, now = 0, foregroundCalls = 0, rectCalls = 0, positions = 0, visible = true
  const settings = { panel: { docked: true, autoBind: true, chatApps: ['wechat.exe'] } }
  const runtime = { pinned: false, panelVisible: true, target: null }
  const info = { hwnd: 1, exe: 'wechat.exe', title: 'chat', visible: true,
    left: 10, top: 20, right: 410, bottom: 820, width: 400, height: 800 }
  const panel = { isDestroyed: () => false, isVisible: () => visible,
    getSize: () => [300, 800], setPosition: () => { positions++ } }
  const win32 = { isWin: () => true,
    getForeground: async () => { foregroundCalls++; return info },
    getWindowRect: async () => { rectCalls++; return info } }
  const mocks = { './store': { loadSettings: () => settings }, './win32': win32, './snap-policy': { pollPolicy } }
  const context = { module: { exports: {} }, require: id => mocks[id], console, Date: { now: () => now },
    setInterval: fn => { tick = fn; return 1 }, setTimeout: () => 2, clearInterval() {}, clearTimeout() {} }
  const filename = path.resolve('electron/snap.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  const stop = context.module.exports.startSnapLoop({ getRuntime: () => runtime, getPanelWindow: () => panel,
    setTarget: target => { runtime.target = target } })
  await tick()
  assert.equal(foregroundCalls, 1)
  assert.equal(positions, 1)
  visible = false // Native hidden state must override runtime's stale true.
  now = 280; await tick()
  assert.equal(foregroundCalls, 1)
  now = 1120; await tick()
  assert.equal(foregroundCalls, 2)
  assert.equal(rectCalls, 0)
  assert.equal(positions, 1)
  runtime.pinned = true
  now = 2240; await tick()
  assert.equal(foregroundCalls, 2)
  assert.equal(rectCalls, 0, 'hidden pinned target rect refresh pauses')
  visible = true; settings.panel.docked = false
  await tick()
  assert.equal(rectCalls, 0, 'undocked pinned target rect refresh pauses')
  settings.panel.docked = true
  await tick()
  assert.equal(rectCalls, 1, 'visible pinned dock resumes rect refresh')
  assert.equal(positions, 2, 'visible pinned dock resumes follow')
  runtime.pinned = false; settings.panel.docked = false; settings.panel.autoBind = false
  now = 4000; await tick()
  assert.equal(foregroundCalls, 2)
  assert.equal(rectCalls, 1, 'undocked auto-bind off does no snapshot calls')
  runtime.panelVisible = false; settings.panel.docked = true
  await tick()
  assert.equal(positions, 2, 'runtime hidden state also suppresses follow')
  stop()

  // Exact process-stem matching (ROADMAP #5): preserve real chat apps, reject substring false positives
  const { matchesChatApp } = context.module.exports
  const storeCtx = {
    module: { exports: {} },
    require: (id) => (id === 'electron' ? { app: { getPath: () => '/tmp' } } : require(id)),
    process: { platform: 'win32' },
    console,
    structuredClone,
  }
  const storeFile = path.resolve('electron/store.js')
  vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), storeCtx, { filename: storeFile })
  const winChatApps = storeCtx.module.exports.defaultSettings().panel.chatApps

  for (const required of ['紫鸟', '紫鸟.exe', '紫鸟浏览器', '紫鸟浏览器.exe', 'JingMai.exe', 'aliworkbench.exe', 'pddworkbench.exe']) {
    assert.ok(winChatApps.includes(required), `WIN_CHAT_APPS must retain ${required}`)
  }

  for (const validExe of [
    '紫鸟.exe',
    '紫鸟浏览器.exe',
    'C:\\Program Files\\Ziniao\\紫鸟浏览器.exe',
    'JingMai.exe',
    'jingmai',
    'aliworkbench.exe',
    'pddworkbench.exe',
    'jm_dd_workbench.exe',
    '得物商家客服.exe',
    '千帆客服工作台.exe',
    '微信小店助手.exe',
    'Grok Bot.exe',
    'qq.exe',
    'tim.exe',
  ]) {
    assert.equal(matchesChatApp(validExe, winChatApps), true, `should match chat app: ${validExe}`)
  }

  // Stem-only config ('紫鸟' / '紫鸟浏览器') still matches real Windows '.exe' process names
  assert.equal(matchesChatApp('紫鸟.exe', ['紫鸟']), true)
  assert.equal(matchesChatApp('紫鸟浏览器.exe', ['紫鸟浏览器']), true)

  for (const nonChatExe of [
    'qqbrowser.exe',
    'qqmusic.exe',
    'runtimebroker.exe',
    'multimedia.exe',
    'dd.exe',
    'jm.exe',
    'c.exe',
    'we.exe',
    'ark.exe',
    'edge.exe',
    '',
    '.exe',
  ]) {
    assert.equal(matchesChatApp(nonChatExe, winChatApps), false, `must NOT false-match substring process: ${nonChatExe}`)
  }

  // Verify snap loop ignores substring false-positive foreground window (qqbrowser.exe) and binds real target (紫鸟浏览器.exe)
  runtime.target = null
  runtime.pinned = false
  runtime.panelVisible = true
  visible = true
  settings.panel.docked = true
  settings.panel.autoBind = true
  settings.panel.chatApps = ['qq.exe', '紫鸟浏览器']
  info.exe = 'qqbrowser.exe'
  now = 6000
  const stop2 = context.module.exports.startSnapLoop({
    getRuntime: () => runtime,
    getPanelWindow: () => panel,
    setTarget: (target) => { runtime.target = target },
  })
  await tick()
  assert.equal(runtime.target, null, 'qqbrowser.exe must not auto-bind to qq.exe')
  info.exe = '紫鸟浏览器.exe'
  now = 7000
  await tick()
  assert.equal(runtime.target?.exe, '紫鸟浏览器.exe', '紫鸟浏览器.exe must auto-bind to 紫鸟浏览器')
  stop2()

  console.log('unit-snap-policy: PASS (policy + exact exe matching + mocked loop; no real windows moved)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
