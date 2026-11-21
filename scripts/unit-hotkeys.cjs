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

  let sentPayloads = []
  let handlersRef = null
  const hotkeys = createHotkeyManager({
    globalShortcut: fakeShortcut,
    getSettings: () => store.loadSettings(),
    getLibrary: () => store.loadLibrary(),
    getTargetExe: () => handlersRef?.runtime.target?.exe || null,
    isSuspended: () => !!handlersRef?.runtime.hotkeysSuspended,
    onTogglePanel: () => { toggled++ },
    onFocusSearch: () => { searched++ },
    onAssist: () => {
      assisted++
      events.push(['trigger-assist', {}])
    },
    onTriggerPhrase: (phraseId) => handlersRef?.triggerPhraseHotkey?.(phraseId, ctxRef),
    onFailuresChanged: (list) => {
      events.push(['hotkey-failures', list])
    },
  })

  const sentWindows = []
  const fakeWin = {
    webContents: {
      send(ch, data) {
        if (ch === 'tauri-event') events.push([data.event, data.payload])
        sentWindows.push([ch, data])
      },
    },
  }
  const electronMock = {
    app: { getPath: () => tempDir },
    dialog: {},
    shell: {},
    clipboard: {},
    BrowserWindow: { getAllWindows: () => [fakeWin] },
    nativeImage: {},
  }
  const handlers = loadModule('electron/handlers.js', {
    electron: electronMock,
    './store': store,
    './media': {},
    './send': {
      sendPhrase: async (phrase, opts) => {
        sendCount++
        sentPayloads.push({ phrase, opts })
        return { ok: true, unbound: !opts.hwnd }
      },
      sendText: async () => { sendCount++; return { ok: true } },
    },
    './send-log': {},
    './win32': { isWin: () => false },
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
    syncHotkeysForTarget: (exe) => hotkeys.syncForTargetExe(exe),
    getHotkeyFailures: () => hotkeys.getFailures(),
  }
  var ctxRef = ctx

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

  // Reset global hotkeys cleanly before testing phrase hotkeys
  await handlers.handleCommand('update_settings', {
    patch: {
      hotkeys: { togglePanel: 'Ctrl+Alt+K', focusSearch: 'Ctrl+Alt+F', assist: 'Ctrl+Alt+J' },
      send: { mode: 'send', key: 'enter', appRules: [{ exe: 'JingMai.exe', mode: 'fill', key: 'ctrl_enter' }] },
    },
  }, ctx)

  // 3. Phrase global hotkeys: registration, usability check, conflict priority, OS occupation, and app-scoped groups
  const backupBeforePhrases = await handlers.handleCommand('backup_now', {}, ctx)
  const saveRes = await handlers.handleCommand('save_library', {
    origin: 'manager',
    library: {
      version: 2,
      groups: [
        {
          id: 'g-common',
          name: '通用',
          scope: 'company',
          apps: [],
          phrases: [
            { id: 'p-welcome', title: '欢迎语', content: '您好，请问有什么可以帮您？', hotkey: 'Alt+1' },
            { id: 'p-empty', title: '空内容话术', content: '   ', images: [], files: [], hotkey: 'Alt+2' },
            { id: 'p-dup-global', title: '撞全局键', content: '测试全局冲突', hotkey: 'Ctrl+Alt+K' },
            { id: 'p-dup-phrase', title: '撞欢迎语', content: '第二条抢 Alt+1', hotkey: 'Alt+1' },
            { id: 'p-occupied', title: '被系统占用', content: '测试系统占用', hotkey: 'Ctrl+Alt+M' },
          ],
        },
        {
          id: 'g-jingmai',
          name: '京麦专属组',
          scope: 'private',
          apps: ['JingMai.exe'],
          phrases: [
            { id: 'p-jm', title: '京麦催付', content: '亲，京麦订单记得付款哦', hotkey: 'Alt+6' },
          ],
        },
      ],
      stickers: [],
    },
  }, ctx)

  assert.equal(registered.has('Alt+1'), true, 'usable phrase hotkey must be registered')
  assert.equal(registered.has('Alt+2'), false, 'empty phrase without text/media must not register hotkey')
  assert.equal(registered.has('Alt+6'), true, 'app-scoped phrase registers when no target exe restricts it yet')
  assert.equal(saveRes.hotkeyFailures.length, 3, 'global conflict + phrase duplicate + OS occupied all reported')
  assert.ok(saveRes.hotkeyFailures.some((f) => f.hotkey === 'Ctrl+Alt+K' && /呼出\/隐藏面板/.test(f.reason)))
  assert.ok(saveRes.hotkeyFailures.some((f) => f.hotkey === 'Alt+1' && /欢迎语/.test(f.reason)))
  assert.ok(saveRes.hotkeyFailures.some((f) => f.hotkey === 'Ctrl+Alt+M' && /占用/.test(f.reason)))

  // Switching target to WeChat unregisters JingMai-only Alt+6 without dropping common Alt+1
  handlers.setTarget({ hwnd: 101, exe: 'WeChat.exe', title: '微信', bound: false }, { emit: true, onTargetExeChanged: (exe) => hotkeys.syncForTargetExe(exe) })
  assert.equal(registered.has('Alt+1'), true)
  assert.equal(registered.has('Alt+6'), false, 'JingMai-only hotkey must not hijack keystrokes while WeChat is active')

  const unregSnapshot = unregisterCount
  // Same-exe window move tick must NOT churn globalShortcut registrations
  handlers.setTarget({ hwnd: 101, exe: 'WeChat.exe', title: '微信 (移动窗口)', bound: false }, { emit: false, onTargetExeChanged: (exe) => hotkeys.syncForTargetExe(exe) })
  assert.equal(unregisterCount, unregSnapshot, 'same-exe snap ticks must not unregister/re-register hotkeys')

  // Switching target to JingMai activates Alt+6 and sends using JingMai's per-app rule (fill + ctrl_enter)
  handlers.setTarget({ hwnd: 202, exe: 'JingMai.exe', title: '京麦工作台', bound: true }, { emit: true, onTargetExeChanged: (exe) => hotkeys.syncForTargetExe(exe) })
  assert.equal(registered.has('Alt+6'), true)

  const unregBeforeTrigger = unregisterCount
  await registered.get('Alt+6')()
  assert.equal(sentPayloads.length, 1)
  assert.equal(sentPayloads[0].phrase.id, 'p-jm')
  assert.equal(sentPayloads[0].opts.mode, 'fill', 'must respect JingMai per-app fill rule')
  assert.equal(sentPayloads[0].opts.key, 'ctrl_enter', 'must respect JingMai per-app ctrl_enter rule')
  assert.equal(sentPayloads[0].opts.hwnd, 202)
  assert.equal(unregisterCount, unregBeforeTrigger, 'usage bump from hotkey send must not churn globalShortcut registrations')

  const reloadedLib = store.loadLibrary()
  const jmPhrase = reloadedLib.groups.find((g) => g.id === 'g-jingmai').phrases[0]
  assert.equal(jmPhrase.useCount, 1, 'hotkey trigger must increment phrase useCount')
  assert.ok(Number.isFinite(jmPhrase.lastUsedAt), 'hotkey trigger must record lastUsedAt')
  assert.ok(events.some(([ev, payload]) => ev === 'phrase-hotkey-triggered' && payload.phraseId === 'p-jm'))

  // panel-usage save_library must NOT churn globalShortcut registrations
  const unregBeforeUsageSave = unregisterCount
  await handlers.handleCommand('save_library', { library: reloadedLib, origin: 'panel-usage' }, ctx)
  assert.equal(unregisterCount, unregBeforeUsageSave, 'panel-usage saves must skip hotkey re-registration')

  // restore_backup re-syncs phrase hotkeys
  await handlers.handleCommand('restore_backup', { id: backupBeforePhrases.id }, ctx)
  assert.equal(registered.has('Alt+1'), false, 'restoring pre-phrase backup must unregister removed phrase hotkeys')
  assert.equal(registered.has('Alt+6'), false)

  // 4. Disjoint group.apps may reuse the same phrase hotkey without hijacking each other,
  //    overlapping group.apps still report conflict, and modifier order (Alt+Ctrl+X vs Ctrl+Alt+X) normalizes identically
  sentPayloads = []
  const scopedSave = await handlers.handleCommand('save_library', {
    origin: 'manager',
    library: {
      version: 2,
      groups: [
        {
          id: 'g-qianniu',
          name: '千牛组',
          scope: 'private',
          apps: ['AliWorkbench.exe'],
          phrases: [
            { id: 'p-qn', title: '千牛快捷回复', content: '千牛亲您好', hotkey: 'Ctrl+Alt+8' },
          ],
        },
        {
          id: 'g-pdd',
          name: '拼多多组',
          scope: 'private',
          apps: ['pddworkbench.exe'],
          phrases: [
            { id: 'p-pdd', title: '拼多多快捷回复', content: '拼多多亲您好', hotkey: 'Alt+Ctrl+8' },
          ],
        },
        {
          id: 'g-pdd-overlap',
          name: '拼多多重叠组',
          scope: 'private',
          apps: ['pddworkbench.exe', 'JingMai.exe'],
          phrases: [
            { id: 'p-pdd-2', title: '拼多多重复键', content: '冲突文案', hotkey: 'Ctrl+Alt+8' },
          ],
        },
        {
          id: 'g-mod-order',
          name: '修饰键序冲突组',
          scope: 'company',
          apps: [],
          phrases: [
            { id: 'p-mod-global', title: '倒序撞全局', content: '测试修饰键序', hotkey: 'Alt+Ctrl+K' },
          ],
        },
      ],
      stickers: [],
    },
  }, ctx)

  // Switch active target to pddworkbench: g-qianniu is inactive, so g-pdd MUST register and trigger p-pdd!
  handlers.setTarget(
    { hwnd: 303, exe: 'pddworkbench.exe', title: '拼多多商家', bound: true },
    { emit: true, onTargetExeChanged: (exe) => hotkeys.syncForTargetExe(exe) },
  )
  const pddFailures = hotkeys.getFailures()
  assert.ok(
    !pddFailures.some((f) => /千牛快捷回复/.test(f.reason)),
    'disjoint app-scoped groups (AliWorkbench vs pddworkbench) must not report conflict with each other',
  )
  assert.ok(
    pddFailures.some((f) => f.hotkey === 'Ctrl+Alt+8' && /拼多多快捷回复/.test(f.reason)),
    'overlapping app-scoped group must still report conflict even when modifier order differs',
  )
  assert.ok(
    pddFailures.some((f) => f.hotkey === 'Alt+Ctrl+K' && /呼出\/隐藏面板/.test(f.reason)),
    'Alt+Ctrl+K must be normalized as conflicting with Ctrl+Alt+K',
  )
  assert.equal(registered.has('Alt+Control+8'), true, 'active pddworkbench phrase hotkey must be registered on OS')
  await registered.get('Alt+Control+8')()
  assert.equal(sentPayloads.length, 1)
  assert.equal(sentPayloads[0].phrase.id, 'p-pdd', 'triggering shortcut in pddworkbench must send p-pdd, not be blocked by inactive AliWorkbench group')

  // Switch active target to AliWorkbench: g-qianniu becomes active and registers Control+Alt+8
  handlers.setTarget(
    { hwnd: 404, exe: 'AliWorkbench.exe', title: '千牛工作台', bound: true },
    { emit: true, onTargetExeChanged: (exe) => hotkeys.syncForTargetExe(exe) },
  )
  assert.equal(registered.has('Control+Alt+8'), true, 'switching to AliWorkbench must register g-qianniu phrase hotkey')
  assert.equal(registered.has('Alt+Control+8'), false, 'inactive pddworkbench hotkey must be unregistered')
  await registered.get('Control+Alt+8')()
  assert.equal(sentPayloads.length, 2)
  assert.equal(sentPayloads[1].phrase.id, 'p-qn')
  assert.ok(scopedSave && Array.isArray(scopedSave.hotkeyFailures))

  // 5. Verify panel.js wires trigger-assist and phrase-hotkey-triggered events
  const panelSource = fs.readFileSync('frontend/panel/panel.js', 'utf8')
  assert.match(panelSource, /listen\(['"]trigger-assist['"],\s*\(\)\s*=>\s*\{\s*askAi\(\)\s*\}\)/)
  assert.match(panelSource, /listen\(['"]phrase-hotkey-triggered['"]/)

  fs.rmSync(tempDir, { recursive: true, force: true })
  console.log('unit-hotkeys: PASS (assist + phrase hotkeys, dynamic rebind, conflicts, app-scoped groups, modifier order, per-app send rules)')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
