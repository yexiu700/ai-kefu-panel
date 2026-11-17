'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function loadModule(relFile, mocks = {}) {
  const filename = path.resolve(relFile)
  const realRequire = createRequire(filename)
  const sandbox = {
    module: { exports: {} },
    require: (id) => (id in mocks ? mocks[id] : realRequire(id)),
    console,
    process,
    Buffer,
    Uint8Array,
    ArrayBuffer,
    structuredClone,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return sandbox.module.exports
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-hotkeys-'))
  const store = loadModule('electron/store.js', {
    electron: { app: { getPath: () => tempDir } },
  })

  // 1. Default settings contain Ctrl+Alt+K / Ctrl+Alt+F / Ctrl+Alt+J, and clearing focusSearch/assist to "" persists
  const initial = store.loadSettings()
  assert.equal(initial.hotkeys.togglePanel, 'Ctrl+Alt+K')
  assert.equal(initial.hotkeys.focusSearch, 'Ctrl+Alt+F')
  assert.equal(initial.hotkeys.assist, 'Ctrl+Alt+J')

  const cleared = store.updateSettings({ hotkeys: { assist: '', focusSearch: '' } })
  assert.equal(cleared.hotkeys.assist, '', 'clearing assist hotkey to empty string must persist')
  assert.equal(cleared.hotkeys.focusSearch, '', 'clearing focusSearch hotkey to empty string must persist')
  assert.equal(cleared.hotkeys.togglePanel, 'Ctrl+Alt+K')
  store.updateSettings({ hotkeys: { assist: 'Ctrl+Alt+J', focusSearch: 'Ctrl+Alt+F' } })

  // 2. Hotkey manager registers toggle, search, assist; reports occupied failures; and supports dynamic rebind + suspend
  const registered = new Map()
  const occupied = new Set()
  let unregisterCount = 0
  const fakeShortcut = {
    unregisterAll() {
      unregisterCount++
      registered.clear()
    },
    register(acc, cb) {
      if (acc.includes('InvalidKey')) throw new Error('Invalid accelerator')
      if (occupied.has(acc)) return false
      registered.set(acc, cb)
      return true
    },
  }

  const events = []
  let toggled = 0
  let searched = 0
  let assisted = 0
  let sendCount = 0

  const { createHotkeyManager, acceleratorFromSetting } = require('../electron/hotkeys')
  assert.equal(acceleratorFromSetting('Ctrl + Alt + J'), 'Control+Alt+J')
  assert.equal(acceleratorFromSetting(''), null)
  assert.equal(acceleratorFromSetting(null), null)

  let handlersRef = null
  const hotkeys = createHotkeyManager({
    globalShortcut: fakeShortcut,
    getSettings: () => store.loadSettings(),
    isSuspended: () => !!handlersRef?.runtime.hotkeysSuspended,
    onTogglePanel: () => { toggled++ },
    onFocusSearch: () => { searched++ },
    onAssist: () => {
      assisted++
      events.push(['trigger-assist', {}])
    },
    onFailuresChanged: (list) => {
      events.push(['hotkey-failures', list])
    },
  })

  const electronMock = {
    app: { getPath: () => tempDir },
    dialog: {},
    shell: {},
    clipboard: {},
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: {},
  }
  const handlers = loadModule('electron/handlers.js', {
    electron: electronMock,
    './store': store,
    './media': {},
    './send': {
      sendPhrase: async () => { sendCount++; return { ok: true } },
      sendText: async () => { sendCount++; return { ok: true } },
    },
    './send-log': {},
    './win32': {},
    './assist': { getAssistState: () => ({ phase: 'idle' }) },
    './feishu-sync': {},
    './feishu-config': {},
  })
  handlersRef = handlers

  const ctx = {
    getPanelWindow: () => null,
    openManager: () => {},
    setPanelVisible: () => {},
    broadcast: (ev, payload) => events.push([ev, payload]),
    syncHotkeys: () => hotkeys.sync(),
    getHotkeyFailures: () => hotkeys.getFailures(),
  }

  assert.deepEqual(hotkeys.sync(), [])
  assert.deepEqual([...registered.keys()], ['Control+Alt+K', 'Control+Alt+F', 'Control+Alt+J'])

  // Triggering assist hotkey only notifies panel via event, never sends directly
  registered.get('Control+Alt+J')()
  assert.equal(assisted, 1)
  assert.equal(sendCount, 0, 'assist hotkey must never directly send messages')

  // Updating settings immediately re-registers hotkeys without app restart
  const updated = await handlers.handleCommand('update_settings', {
    patch: { hotkeys: { assist: 'Ctrl+Shift+A' } },
  }, ctx)
  assert.equal(updated.settings.hotkeys.assist, 'Ctrl+Shift+A')
  assert.deepEqual(updated.hotkeyFailures, [])
  assert.ok(!registered.has('Control+Alt+J'))
  assert.ok(registered.has('Control+Shift+A'))
  assert.ok(unregisterCount >= 2)

  // Simulate manager recorder sequence: suspend(true) -> update_settings -> suspend(false)
  await handlers.handleCommand('suspend_hotkeys', { suspended: true }, ctx)
  assert.equal(registered.size, 0, 'shortcuts unregistered while recording')
  await handlers.handleCommand('update_settings', {
    patch: { hotkeys: { assist: 'Alt+Q' } },
  }, ctx)
  assert.equal(registered.size, 0, 'stays unregistered until recording finishes')
  await handlers.handleCommand('suspend_hotkeys', { suspended: false }, ctx)
  assert.ok(registered.has('Alt+Q'), 're-registers updated shortcut when suspend ends')

  // Occupied shortcut reports { hotkey, reason } in update_settings and get_hotkey_failures
  occupied.add('Control+Alt+M')
  const conflictRes = await handlers.handleCommand('update_settings', {
    patch: { hotkeys: { assist: 'Ctrl+Alt+M' } },
  }, ctx)
  assert.equal(conflictRes.hotkeyFailures.length, 1)
  assert.equal(conflictRes.hotkeyFailures[0].hotkey, 'Ctrl+Alt+M')
  assert.match(conflictRes.hotkeyFailures[0].reason, /占用/)
  const queriedFailures = await handlers.handleCommand('get_hotkey_failures', {}, ctx)
  assert.deepEqual(queriedFailures, conflictRes.hotkeyFailures)

  // Duplicate shortcut within settings reports conflict
  const dupRes = await handlers.handleCommand('update_settings', {
    patch: { hotkeys: { focusSearch: 'Ctrl+Alt+K', assist: '' } },
  }, ctx)
  assert.equal(dupRes.hotkeyFailures.length, 1)
  assert.equal(dupRes.hotkeyFailures[0].hotkey, 'Ctrl+Alt+K')
  assert.match(dupRes.hotkeyFailures[0].reason, /冲突|重复|相同/)

  // 3. Verify panel.js wires trigger-assist event to askAi()
  const panelSource = fs.readFileSync('frontend/panel/panel.js', 'utf8')
  assert.match(panelSource, /listen\(['"]trigger-assist['"],\s*\(\)\s*=>\s*\{\s*askAi\(\)\s*\}\)/)

  console.log('unit-hotkeys: PASS (assist hotkey, dynamic rebind, recorder suspend sequence, clearable hotkeys, failure reporting)')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
