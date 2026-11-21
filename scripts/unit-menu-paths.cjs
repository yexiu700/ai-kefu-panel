#!/usr/bin/env node
'use strict'
/**
 * Unit test for ROADMAP #9:
 * - Panel main menu distinguishes send logs (%APPDATA%\AI客服\logs) from
 *   phrase/settings data dir (%APPDATA%\ai-kefu-panel\ai-kefu-panel)
 *   without moving either directory.
 * - Both menu items stay silent on success and surface 'err' toast on failure.
 * - handlers.js exposes both dataDir & logDir in get_app_info and propagates
 *   shell.openPath errors consistently for both open_send_logs and open_data_dir.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '..')

function extractBetween(src, startMarker, endMarker, label) {
  const s = src.indexOf(startMarker)
  assert.notEqual(s, -1, `missing start marker for ${label}: ${startMarker}`)
  const e = src.indexOf(endMarker, s)
  assert.notEqual(e, -1, `missing end marker for ${label}: ${endMarker}`)
  return src.slice(s, e)
}

function loadPanelMenuHarness() {
  const panelPath = path.join(ROOT, 'frontend/panel/panel.js')
  const src = fs.readFileSync(panelPath, 'utf8')
  const escSrc = extractBetween(src, '  const esc =', '  let toastTimer =', 'esc')
  const itemSrc = extractBetween(src, '  const item =', '  function openTargetMenu()', 'item')
  const menuSrc = extractBetween(src, '  function openMainMenu()', '  async function patchSettings(', 'openMainMenu')

  const calls = []
  const toasts = []
  let popState = { anchor: null, html: '', onClick: null }
  let rejectCmd = null

  const sandbox = {
    S: {
      settings: {
        theme: 'auto',
        send: { mode: 'send', pasteDelayMs: 80, restoreClipboard: true },
        panel: { alwaysOnTop: true },
        hotkeys: { togglePanel: 'Ctrl+Alt+K', focusSearch: 'Ctrl+Alt+F', assist: 'Ctrl+Alt+J' },
      },
      target: null,
    },
    window: {
      SendRule: { resolveSendRule: () => ({ matched: false, mode: 'send', key: 'enter' }) },
      PanelSearch: require('../frontend/panel/search.js'),
    },
    $: (sel) => ({ selector: sel }),
    openPop: (anchor, html, onClick) => {
      popState = { anchor, html, onClick }
    },
    openFeishuChooser: () => calls.push({ cmd: 'ui:feishu' }),
    patchSettings: async (patch) => calls.push({ cmd: 'patchSettings', patch }),
    invoke: async (cmd, args) => {
      calls.push({ cmd, args })
      if (rejectCmd === cmd) throw new Error(`${cmd}-boom`)
      return true
    },
    toast: (msg, kind) => toasts.push({ msg, kind }),
  }

  vm.runInNewContext(`${escSrc}\n${itemSrc}\n${menuSrc}\nthis.openMainMenu = openMainMenu`, sandbox, {
    filename: panelPath,
  })

  return {
    openMainMenu: sandbox.openMainMenu,
    getPop: () => popState,
    calls,
    toasts,
    setRejectCmd: (cmd) => { rejectCmd = cmd },
  }
}

function loadHandlersHarness(tmpRoot) {
  const appData = path.join(tmpRoot, 'AppData', 'Roaming')
  const userData = path.join(appData, 'ai-kefu-panel')
  const openedPaths = []
  let openPathError = ''

  const electronMock = {
    app: {
      getPath: (key) => {
        if (key === 'appData') return appData
        if (key === 'userData') return userData
        return tmpRoot
      },
      quit: () => {},
      setLoginItemSettings: () => {},
      getLoginItemSettings: () => ({ openAtLogin: false }),
    },
    dialog: {},
    shell: {
      openPath: async (p) => {
        openedPaths.push(p)
        return openPathError
      },
      openExternal: async () => {},
    },
    clipboard: { readText: () => '', writeText: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  }

  function loadWithElectron(relPath, extraMocks = {}) {
    const abs = path.join(ROOT, relPath)
    const realRequire = createRequire(abs)
    const mod = { exports: {} }
    const sandbox = {
      module: mod,
      exports: mod.exports,
      require: (id) => {
        if (id === 'electron') return electronMock
        if (id in extraMocks) return extraMocks[id]
        return realRequire(id)
      },
      __dirname: path.dirname(abs),
      __filename: abs,
      console,
      process,
      Buffer,
      Uint8Array,
      ArrayBuffer,
      structuredClone,
      setTimeout,
      clearTimeout,
    }
    vm.runInNewContext(fs.readFileSync(abs, 'utf8'), sandbox, { filename: abs })
    return mod.exports
  }

  const store = loadWithElectron('electron/store.js')
  const sendLog = loadWithElectron('electron/send-log.js')
  const handlers = loadWithElectron('electron/handlers.js', {
    './store': store,
    './send-log': sendLog,
    './media': {},
    './send': { sendText: async () => ({ ok: true }), sendPhrase: async () => ({ ok: true }) },
    './win32': { listOpenApps: async () => [] },
    './assist': { getState: () => ({ phase: 'idle' }), localCloudStatus: () => ({}) },
    './feishu-sync': {},
    './feishu-config': {},
  })

  return {
    appData,
    userData,
    store,
    sendLog,
    handlers,
    openedPaths,
    setOpenPathError: (err) => { openPathError = err },
  }
}

async function main() {
  // 1. Panel main menu renders distinct path hints and wires both directory actions
  const menu = loadPanelMenuHarness()
  menu.openMainMenu()
  const { html, onClick } = menu.getPop()

  assert.match(html, /data-k="send-logs"/, 'menu should include send-logs action')
  assert.match(html, /打开发送日志/, 'menu should label send logs action')
  assert.match(html, /AI客服\\logs/, 'send-logs item should hint AI客服\\logs directory')

  assert.match(html, /data-k="data-dir"/, 'menu should include data-dir action')
  assert.match(html, /打开话术与设置目录/, 'menu should label phrase/settings data directory action')
  assert.match(html, /ai-kefu-panel/, 'data-dir item should hint ai-kefu-panel directory')

  // Success path: silent (no info/ok toast)
  await onClick('send-logs')
  await onClick('data-dir')
  assert.deepEqual(
    menu.calls.map((c) => c.cmd),
    ['open_send_logs', 'open_data_dir'],
    'clicking send-logs and data-dir should invoke corresponding IPC commands',
  )
  assert.equal(menu.toasts.length, 0, 'opening directories successfully must not trigger toasts')

  // Error path: surfaces 'err' toast for both actions
  menu.setRejectCmd('open_send_logs')
  await onClick('send-logs')
  assert.equal(menu.toasts.length, 1)
  assert.equal(menu.toasts[0].kind, 'err')
  assert.match(menu.toasts[0].msg, /打开日志失败/)

  menu.setRejectCmd('open_data_dir')
  await onClick('data-dir')
  assert.equal(menu.toasts.length, 2)
  assert.equal(menu.toasts[1].kind, 'err')
  assert.match(menu.toasts[1].msg, /打开目录失败/)

  // 2. Main-process handlers keep directories separate, expose both in get_app_info, and surface openPath errors
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-menu-paths-'))
  try {
    const h = loadHandlersHarness(tmpRoot)
    const info = await h.handlers.handleCommand('get_app_info', {}, {})
    const expectedDataDir = path.join(h.userData, 'ai-kefu-panel')
    const expectedLogDir = path.join(h.appData, 'AI客服', 'logs')

    assert.equal(info.dataDir, expectedDataDir, 'dataDir must remain double-nested ai-kefu-panel')
    assert.equal(info.logDir, expectedLogDir, 'logDir must remain %APPDATA%\\AI客服\\logs')
    assert.notEqual(info.dataDir, info.logDir, 'dataDir and logDir are intentionally separate')

    assert.equal(await h.handlers.handleCommand('open_send_logs', {}, {}), true)
    assert.equal(fs.existsSync(expectedLogDir), true, 'open_send_logs creates logDir before opening')

    assert.equal(await h.handlers.handleCommand('open_data_dir', {}, {}), true)
    assert.equal(fs.existsSync(expectedDataDir), true, 'open_data_dir ensures dataDir exists before opening')

    assert.deepEqual(h.openedPaths, [expectedLogDir, expectedDataDir])

    h.setOpenPathError('系统找不到指定的文件')
    await assert.rejects(
      () => h.handlers.handleCommand('open_send_logs', {}, {}),
      /系统找不到指定的文件/,
    )
    await assert.rejects(
      () => h.handlers.handleCommand('open_data_dir', {}, {}),
      /系统找不到指定的文件/,
    )
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }

  console.log('PASS unit-menu-paths')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
