'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { app, dialog, shell, clipboard, BrowserWindow, nativeImage } = require('electron')
const store = require('./store')
const { sendText } = require('./send')
const { getLogDir } = require('./send-log')
const win32 = require('./win32')
const assist = require('./assist')
const feishu = require('./feishu-sync')
let feishuSyncPending = null

/** @type {{ panelVisible: boolean, target: any, pinned: boolean, hotkeysSuspended: boolean, autostart: boolean, stubs: string[] }} */
const runtime = {
  panelVisible: true,
  target: null,
  pinned: false,
  hotkeysSuspended: false,
  autostart: false,
  stubs: [],
}

function setTarget(next, opts = {}) {
  runtime.target = next
  if (opts.emit) emitAll('target-changed', runtime.target)
}


function stub(cmd, value) {
  if (!runtime.stubs.includes(cmd)) {
    runtime.stubs.push(cmd)
    console.log(`[ipc:stub] ${cmd}`)
  }
  return value
}

function findPhrase(library, phraseId) {
  for (const g of library.groups || []) {
    const p = (g.phrases || []).find((x) => x.id === phraseId)
    if (p) return p
  }
  return null
}

function emitAll(event, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('tauri-event', { event, payload }) } catch { /* ignore */ }
  }
}

function getPanelState() {
  const settings = store.loadSettings()
  return {
    visible: runtime.panelVisible,
    side: settings.panel?.side || 'right',
    width: settings.panel?.width || 300,
    docked: !!settings.panel?.docked,
    alwaysOnTop: !!settings.panel?.alwaysOnTop,
  }
}

/**
 * @param {string} cmd
 * @param {any} args
 * @param {{ getPanelWindow: Function, openManager: Function, setPanelVisible: Function, broadcast: Function }} ctx
 */
function asFailureList(v) {
  return Array.isArray(v) ? v : []
}

async function handleCommand(cmd, args = {}, ctx) {
  args = args || {}

  switch (cmd) {
    case 'sync_company_from_feishu': {
      if (feishuSyncPending) return feishuSyncPending
      feishuSyncPending = (async () => {
        const settings = store.loadSettings()
        const region = feishu.resolveRegion(args.region, settings)
        store.updateSettings({ feishuLibraryRegion: region })
        const snapshot = store.loadLibrary()
        const synced = await feishu.syncCompanyFromFeishu({ library: snapshot, region, config: feishu.resolveConfig(settings, process.env, region), globalHotkeys: Object.values(settings.hotkeys || {}) })
        if (synced.result.ok) {
          // 网络请求期间可能有私人话术或收藏编辑，保存前合并最新本地库。
          const latest = store.loadLibrary()
          const company = synced.library.groups.filter(g => g.scope !== 'private')
          const old = new Map(latest.groups.flatMap(g => (g.phrases || []).map(p => [p.id, p])))
          for (const g of company) for (const p of g.phrases) {
            const prev = old.get(p.id)
            if (prev) for (const k of ['favorite', 'useCount', 'lastUsedAt', 'createdAt']) p[k] = prev[k]
          }
          const reserved = new Set([...feishu.localNonCompanyHotkeys(latest), ...Object.values(settings.hotkeys || {})].filter(Boolean).map(h => h.trim().toLowerCase()))
          for (const g of company) for (const p of g.phrases) if (p.hotkey && reserved.has(p.hotkey.toLowerCase())) {
            synced.result.hotkeyCleared.push(`${p.title}?${p.hotkey}?`); p.hotkey = null
          }
          store.backupNow(Infinity)
          store.saveLibrary(feishu.replaceCompanyGroups(latest, company).library, { skipBackup: true })
          emitAll('library-changed', { origin: 'feishu-sync' })
        }
        store.updateSettings({ feishuLastSyncMessage: synced.result.message, ...(synced.result.ok ? { feishuLastSyncAt: new Date().toISOString() } : {}) })
        return synced.result
      })()
      try { return await feishuSyncPending } finally { feishuSyncPending = null }
    }

    case 'get_library':
    case 'read_local_library':
      return store.normalizeLibrary(store.loadLibrary())

    case 'save_library': {
      const library = args.library
      if (!library) throw new Error('library required')
      // 仅记使用次数的保存不做备份，免得挤掉真正的历史备份
      store.saveLibrary(library, { skipBackup: args.origin === 'panel-usage' })
      emitAll('library-changed', { origin: args.origin ?? null })
      // 原版前端期望 { hotkeyFailures, conflict? }，不能返回 true
      return { hotkeyFailures: [], conflict: undefined }
    }

    case 'get_settings':
      return store.loadSettings()

    case 'update_settings': {
      const next = store.updateSettings(args.patch || {})
      emitAll('settings-changed', next)
      // reflect alwaysOnTop / width
      try {
        const panel = ctx.getPanelWindow?.()
        if (panel && !panel.isDestroyed()) {
          if (typeof next.panel?.alwaysOnTop === 'boolean') panel.setAlwaysOnTop(next.panel.alwaysOnTop)
          if (typeof next.panel?.width === 'number') {
            const b = panel.getBounds()
            panel.setBounds({ ...b, width: next.panel.width })
          }
        }
      } catch { /* ignore */ }
      // 原版：updateSettings → { settings, hotkeyFailures }；缺 settings 会让 chatApps.filter 炸
      return { settings: next, hotkeyFailures: [] }
    }

    case 'get_target':
      return runtime.target

    case 'list_open_apps': {
      const apps = await win32.listOpenApps()
      return Array.isArray(apps) ? apps : []
    }

    case 'get_panel_state':
      return getPanelState()

    case 'get_hotkey_failures':
      return asFailureList([])

    case 'get_app_info':
      return {
        name: 'AI客服',
        version: '0.2.18-shell',
        dataDir: store.getDataDir(),
        platform: process.platform,
      }

    case 'check_for_update':
      return null
    case 'get_update_info':
      return null
    case 'install_update':
      return stub('install_update', false)
    case 'dismiss_update':
      return true

    case 'get_announcement':
      return null
    case 'dismiss_announcement':
      return true
    case 'open_announcement_link':
      if (args.url) await shell.openExternal(args.url)
      return true

    case 'capture_permission':
      return { supported: false, granted: false, accessibility: true, status: 'unsupported' }
    case 'get_capture_permission':
    case 'request_capture_permission':
      return { supported: false, granted: false, accessibility: true, status: 'unsupported' }

    case 'suspend_hotkeys':
      runtime.hotkeysSuspended = !!args.suspended
      return true

    case 'send_phrase': {
      const lib = store.loadLibrary()
      const phrase = findPhrase(lib, args.phraseId)
      if (!phrase) throw new Error('话术不存在')
      const settings = store.loadSettings()
      const mode = args.mode || settings.send?.mode || 'send'
      emitAll('send-state', { sending: true, phraseId: args.phraseId })
      try {
        const result = await sendText(phrase.content || '', {
          mode,
          key: settings.send?.key || 'enter',
          pasteDelayMs: settings.send?.pasteDelayMs ?? 80,
          restoreClipboard: runtime.target?.hwnd
            ? settings.send?.restoreClipboard !== false
            : false,
          intervalMs: settings.send?.intervalMs ?? 0,
          hwnd: runtime.target?.hwnd,
          exe: runtime.target?.exe,
          onRebound: r => {
            runtime.target = { ...runtime.target, hwnd: r.hwnd, title: r.targetTitle, exe: r.exe }
            emitAll('target-changed', runtime.target)
          },
        })
        return result
      } finally {
        emitAll('send-state', { sending: false, phraseId: null })
      }
    }

    case 'send_sticker': {
      // Sticker send: copy path note for now
      const lib = store.loadLibrary()
      const st = (lib.stickers || []).find((s) => s.name === args.name || s.id === args.name)
      if (!st) throw new Error('表情不存在')
      return stub('send_sticker', { ok: false, reason: 'sticker-send-not-wired', name: args.name })
    }

    case 'get_stats':
      return store.getStats()

    case 'list_backups':
      return store.listBackups()
    case 'backup_now':
      return store.backupNow()
    case 'restore_backup':
      return store.restoreBackup(args.id)

    case 'get_autostart':
      return runtime.autostart
    case 'set_autostart': {
      runtime.autostart = !!args.enabled
      // Soft: Electron login item on supported platforms
      try {
        if (app.setLoginItemSettings) {
          app.setLoginItemSettings({ openAtLogin: runtime.autostart, path: process.execPath })
        }
      } catch (e) {
        console.warn('[autostart]', e)
      }
      return runtime.autostart
    }

    case 'show_panel':
      runtime.panelVisible = true
      ctx.setPanelVisible?.(true)
      emitAll('panel-state', getPanelState())
      return true
    case 'hide_panel':
      runtime.panelVisible = false
      ctx.setPanelVisible?.(false)
      emitAll('panel-state', getPanelState())
      return true

    case 'focus_input':
      return stub('focus_input', true)
    case 'release_input':
      return stub('release_input', true)

    case 'pin_target': {
      if (runtime.target) {
        runtime.target = { ...runtime.target, bound: true }
        runtime.pinned = true
        emitAll('target-changed', runtime.target)
      }
      return runtime.target
    }
    case 'pin_window': {
      let title = args.title || ''
      let exe = args.exe || ''
      const hwnd = Number(args.hwnd ?? 0)
      if (hwnd && (!title || !exe) && win32.isWin()) {
        try {
          const info = await win32.getWindowRect(hwnd)
          if (info) {
            title = title || info.title || ''
            exe = exe || info.exe || ''
            runtime.target = {
              hwnd,
              title: title || '已固定窗口',
              exe,
              bound: true,
              rect: {
                left: info.left, top: info.top, right: info.right, bottom: info.bottom,
                width: info.width, height: info.height,
              },
            }
          }
        } catch { /* fall through */ }
      }
      if (!runtime.target || runtime.target.hwnd !== hwnd) {
        runtime.target = {
          hwnd,
          title: title || '已固定窗口',
          exe,
          bound: true,
        }
      } else {
        runtime.target = { ...runtime.target, bound: true, title: title || runtime.target.title, exe: exe || runtime.target.exe }
      }
      runtime.pinned = true
      emitAll('target-changed', runtime.target)
      return runtime.target
    }
    case 'unpin_target': {
      if (runtime.target) {
        runtime.target = { ...runtime.target, bound: false }
      }
      runtime.pinned = false
      emitAll('target-changed', runtime.target)
      return runtime.target
    }

    case 'get_app_icon': {
      const hwnd = Number(args.hwnd || 0)
      if (!hwnd || !win32.isWin()) return new Uint8Array()
      try {
        const bytes = await win32.getAppIcon(hwnd)
        return bytes && bytes.byteLength ? bytes : new Uint8Array()
      } catch (e) {
        console.warn('[get_app_icon]', e)
        return new Uint8Array()
      }
    }

    case 'open_manager':
    case 'open_settings':
      ctx.openManager?.(cmd === 'open_settings' ? (args.tab || 'settings') : (args.tab || null))
      return true

    case 'open_send_logs': {
      const dir = getLogDir()
      fs.mkdirSync(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
      return true
    }

    case 'open_data_dir':
      await shell.openPath(store.getDataDir())
      return true

    case 'contact_author':
      await shell.openExternal('mailto:3128785509@qq.com')
      return true
    case 'copy_author_email':
      clipboard.writeText('3128785509@qq.com')
      return true

    case 'quit_app':
      app.quit()
      return true

    case 'pick_images':
    case 'pick_files':
    case 'pick_file': {
      const isImages = cmd === 'pick_images'
      const win = BrowserWindow.getFocusedWindow()
      const res = await dialog.showOpenDialog(win || undefined, {
        title: args.title || (isImages ? '选择图片' : '选择文件'),
        properties: ['openFile', 'multiSelections'],
        filters: isImages
          ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
          : (args.extensions
            ? [{ name: 'Files', extensions: [].concat(args.extensions) }]
            : undefined),
      })
      if (res.canceled) return []
      return res.filePaths.map((p) => {
        const dest = store.copyIntoMedia(p, isImages ? 'media' : 'media')
        return { name: path.basename(dest), path: dest }
      })
    }

    case 'import_image':
    case 'import_file': {
      // args may include bytes via Tauri channel — soft stub if missing
      return stub(cmd, null)
    }

    case 'get_image_bytes':
    case 'get_file_bytes': {
      const name = args.name
      if (!name) return new Uint8Array()
      // try media dir
      const candidates = [
        path.join(store.mediaDir(), name),
        path.join(store.stickersDir(), name),
        name,
      ]
      for (const p of candidates) {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          return fs.readFileSync(p)
        }
      }
      return new Uint8Array()
    }

    case 'save_text_file': {
      const win = BrowserWindow.getFocusedWindow()
      const res = await dialog.showSaveDialog(win || undefined, {
        defaultPath: args.defaultName || 'export.txt',
        filters: args.extensions
          ? [{ name: 'File', extensions: [].concat(args.extensions) }]
          : undefined,
      })
      if (res.canceled || !res.filePath) return null
      fs.writeFileSync(res.filePath, args.content ?? '', 'utf8')
      return res.filePath
    }

    case 'save_binary_file': {
      // Rare path; accept base64/content if present
      return stub('save_binary_file', null)
    }

    // —— cloud / team / billing (keep UI alive, no cut) ——
    case 'cloud_status':
      return assist.localCloudStatus()
    case 'cloud_captcha':
      return stub('cloud_captcha', { id: null, image: null })
    case 'cloud_send_code':
      return stub('cloud_send_code', { ok: false, message: '本地壳未接团队后端' })
    case 'cloud_login':
      return stub('cloud_login', { ok: false, message: '本地壳未接团队后端' })
    case 'cloud_logout':
      return true
    case 'cloud_create_team':
    case 'cloud_accept_invite':
    case 'team_action':
    case 'submission_action': {
      const kind = args.kind || args.action?.kind || args.action
      // 前端 listMine 期望数组；返回对象会让 .filter 炸
      if (kind === 'listMine' || kind === 'list' || kind === 'listAll') {
        return stub('submission_action:list', [])
      }
      if (kind === 'submit') {
        return stub('submission_action:submit', { ok: true, id: `local-${Date.now()}` })
      }
      return stub('submission_action', { ok: true })
    }
    case 'billing_action':
    case 'product_action':
      return stub(cmd, { ok: false, message: '本地壳未接团队后端' })
    case 'usage_summary':
      return stub('usage_summary', { days: args.days || 7, items: [] })
    case 'open_pay_page':
      if (args.url) await shell.openExternal(args.url)
      return true

    // —— assist / AI (stub; can later wire x.arzopa.com) ——
    case 'get_assist_state':
      return assist.getAssistState()
    case 'assist_trigger':
      return await assist.assistTrigger()
    case 'assist_ask':
      return await assist.assistAsk(args.question)
    case 'assist_choose_product':
      return assist.assistChooseProduct(args.productId)
    case 'assist_confirm_same_buyer':
      return assist.assistConfirmSameBuyer()
    case 'assist_discard':
      return assist.assistDiscard()
    case 'assist_send': {
      const settings = store.loadSettings()
      const text = args.text ?? assist.getAssistState()?.result?.reply ?? ''
      if (!text) return { ok: false, method: 'empty', mode: args.mode || settings.send?.mode || 'send' }
      return await sendText(text, {
        mode: args.mode || settings.send?.mode || 'send',
        key: settings.send?.key || 'enter',
        pasteDelayMs: settings.send?.pasteDelayMs ?? 80,
        // unbound clipboard path must keep the reply on clipboard for manual paste
        restoreClipboard: runtime.target?.hwnd
          ? settings.send?.restoreClipboard !== false
          : false,
        hwnd: runtime.target?.hwnd,
          exe: runtime.target?.exe,
          onRebound: r => {
            runtime.target = { ...runtime.target, hwnd: r.hwnd, title: r.targetTitle, exe: r.exe }
            emitAll('target-changed', runtime.target)
          },
      })
    }

    case 'upload_product_image':
    case 'pick_product_images':
      return stub(cmd, [])
    case 'get_product_image':
      return stub('get_product_image', new Uint8Array())

    case 'get_sync_state':
      return stub('get_sync_state', { team: false, online: false, syncing: false, pending: false })
    case 'sync_now':
      return stub('sync_now', { ok: false })

    default:
      console.warn('[ipc:unknown]', cmd, args)
      runtime.stubs.push(cmd)
      return null
  }
}

module.exports = { handleCommand, runtime, emitAll, getPanelState, setTarget }
