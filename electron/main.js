'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, protocol, net,
} = require('electron')
const store = require('./store')
const { handleCommand, runtime, emitAll, getPanelState, setTarget } = require('./handlers')
const win32 = require('./win32')
const { startSnapLoop } = require('./snap')

const ROOT = path.join(__dirname, '..')
const FRONTEND = path.join(ROOT, 'frontend')

const BRAND = 'AI客服'
function appIcon() {
  const ico = path.join(ROOT, 'build', 'icon.ico')
  const png = path.join(ROOT, 'build', 'icon.png')
  try {
    if (fs.existsSync(ico)) {
      const img = nativeImage.createFromPath(ico)
      if (!img.isEmpty()) return img
    }
    if (fs.existsSync(png)) {
      const img = nativeImage.createFromPath(png)
      if (!img.isEmpty()) return img
    }
  } catch (e) {
    console.warn('[icon]', e)
  }
  return nativeImage.createEmpty()
}


let panelWindow = null
let managerWindow = null
let tray = null
let staticServer = null
let staticPort = 0
let stopSnap = null

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        let pathname = decodeURIComponent(u.pathname)
        if (pathname === '/') pathname = '/index.html'
        const filePath = path.normalize(path.join(FRONTEND, pathname))
        if (!filePath.startsWith(FRONTEND)) {
          res.writeHead(403); res.end('forbidden'); return
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404); res.end('not found: ' + pathname); return
        }
        const ext = path.extname(filePath).toLowerCase()
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        fs.createReadStream(filePath).pipe(res)
      } catch (e) {
        res.writeHead(500); res.end(String(e))
      }
    })
    server.listen(0, '127.0.0.1', () => {
      staticServer = server
      staticPort = server.address().port
      console.log(`[shell] static http://127.0.0.1:${staticPort}`)
      resolve(staticPort)
    })
    server.on('error', reject)
  })
}

function pageUrl(page, label) {
  return `http://127.0.0.1:${staticPort}/${page}?label=${encodeURIComponent(label)}`
}

function preloadPath() {
  return path.join(__dirname, 'preload.js')
}

function createPanelWindow() {
  const settings = store.loadSettings()
  const width = settings.panel?.width || 300
  const height = settings.panel?.floatHeight || 640
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 260,
    minHeight: 360,
    frame: false,
    transparent: false,
    alwaysOnTop: settings.panel?.alwaysOnTop !== false,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#fbf7f0',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--window-label=panel'],
    },
    title: BRAND,
    icon: appIcon(),
  })
  win.loadURL(pageUrl('index.html', 'panel'))
  win.once('ready-to-show', () => {
    win.show()
    runtime.panelVisible = true
    emitAll('panel-state', getPanelState())
  })
  win.on('closed', () => {
    if (panelWindow === win) panelWindow = null
  })
  panelWindow = win
  return win
}

function createManagerWindow(tab) {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.focus()
    if (tab) managerWindow.webContents.send('tauri-event', { event: 'open-tab', payload: { tab } })
    return managerWindow
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f9fc',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--window-label=manager'],
    },
    title: BRAND + ' · 管理',
    icon: appIcon(),
  })
  const url = pageUrl('manager.html', 'manager') + (tab ? `&tab=${encodeURIComponent(tab)}` : '')
  win.loadURL(url)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (managerWindow === win) managerWindow = null
  })
  managerWindow = win
  return win
}

function setPanelVisible(visible) {
  if (!panelWindow || panelWindow.isDestroyed()) {
    if (visible) createPanelWindow()
    return
  }
  if (visible) {
    panelWindow.show()
    panelWindow.focus()
  } else {
    panelWindow.hide()
  }
  runtime.panelVisible = visible
}

function acceleratorFromSetting(s) {
  // Frontend uses Ctrl+Alt+K style; Electron wants CommandOrControl etc.
  if (!s) return null
  return String(s)
    .replace(/CommandOrControl/gi, 'CommandOrControl')
    .replace(/\bCtrl\b/gi, 'Control')
    .replace(/\bCmd\b/gi, 'Command')
    .replace(/\s*\+\s*/g, '+')
}

function registerHotkeys() {
  try { globalShortcut.unregisterAll() } catch { /* ignore */ }
  if (runtime.hotkeysSuspended) return
  const settings = store.loadSettings()
  const toggle = acceleratorFromSetting(settings.hotkeys?.togglePanel)
  const search = acceleratorFromSetting(settings.hotkeys?.focusSearch)
  if (toggle) {
    try {
      globalShortcut.register(toggle, () => {
        const vis = !(panelWindow && panelWindow.isVisible())
        setPanelVisible(vis)
        emitAll('panel-state', getPanelState())
      })
    } catch (e) {
      console.warn('[hotkey] toggle failed', toggle, e)
    }
  }
  if (search) {
    try {
      globalShortcut.register(search, () => {
        setPanelVisible(true)
        emitAll('focus-search', {})
      })
    } catch (e) {
      console.warn('[hotkey] search failed', search, e)
    }
  }
}

function createTray() {
  let img = appIcon()
  if (img.isEmpty()) {
    img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAALElEQVQoka3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAwG8G+gAB8n1nVQAAAABJRU5ErkJggg==')
  }
  try {
    tray = new Tray(img)
  } catch (e) {
    console.warn('[tray] create failed', e)
    return
  }
  const menu = Menu.buildFromTemplate([
    { label: '显示面板', click: () => setPanelVisible(true) },
    { label: '隐藏面板', click: () => setPanelVisible(false) },
    { label: '打开管理', click: () => createManagerWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setToolTip(BRAND)
  tray.setContextMenu(menu)
  tray.on('click', () => setPanelVisible(!(panelWindow && panelWindow.isVisible())))
}

function wireIpc() {
  const ctx = {
    getPanelWindow: () => panelWindow,
    openManager: (tab) => createManagerWindow(tab),
    setPanelVisible,
    broadcast: emitAll,
  }

  ipcMain.handle('tauri-invoke', async (_e, payload) => {
    const { cmd, args } = payload || {}
    try {
      return await handleCommand(cmd, args || {}, ctx)
    } catch (err) {
      console.error('[ipc]', cmd, err)
      throw err
    }
  })

  ipcMain.on('tauri-emit', (_e, msg) => {
    emitAll(msg.event, msg.payload)
  })

  ipcMain.handle('tauri-window', async (e, { action, args }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    switch (action) {
      case 'start_dragging':
        try { win.start() } catch { /* Electron uses -webkit-app-region */ }
        return null
      case 'start_resize_dragging':
        return null
      case 'set_size': {
        const w = args?.size?.width ?? args?.width
        const h = args?.size?.height ?? args?.height
        if (w && h) win.setSize(Math.round(w), Math.round(h))
        return null
      }
      case 'set_position': {
        const x = args?.position?.x ?? args?.x
        const y = args?.position?.y ?? args?.y
        if (typeof x === 'number' && typeof y === 'number') win.setPosition(Math.round(x), Math.round(y))
        return null
      }
      case 'set_always_on_top':
        win.setAlwaysOnTop(!!(args?.value ?? args?.alwaysOnTop ?? true))
        return null
      case 'set_focus':
        win.focus(); return null
      case 'show':
        win.show(); return null
      case 'hide':
        win.hide(); return null
      case 'close':
      case 'destroy':
        win.close(); return null
      case 'outer_position': {
        const [x, y] = win.getPosition(); return { x, y }
      }
      case 'outer_size':
      case 'inner_size': {
        const [width, height] = win.getSize(); return { width, height }
      }
      case 'inner_position': {
        const [x, y] = win.getPosition(); return { x, y }
      }
      case 'is_visible':
        return win.isVisible()
      case 'is_focused':
        return win.isFocused()
      case 'is_always_on_top':
        return win.isAlwaysOnTop()
      case 'scale_factor':
        return win.webContents.getZoomFactor?.() || 1
      case 'set_title':
        if (args?.title) win.setTitle(args.title); return null
      case 'title':
        return win.getTitle()
      case 'center':
        win.center(); return null
      case 'minimize':
        win.minimize(); return null
      case 'unminimize':
        win.restore(); return null
      case 'maximize':
        win.maximize(); return null
      case 'unmaximize':
        win.unmaximize(); return null
      case 'get_all_windows':
        return BrowserWindow.getAllWindows().map((w) => w.webContents.getURL().includes('manager') ? 'manager' : 'panel')
      case 'theme':
        return 'light'
      default:
        return null
    }
  })
}

function registerMediaProtocol() {
  protocol.handle('huiyou-media', async (request) => {
    try {
      const u = new URL(request.url)
      const p = u.searchParams.get('p')
      if (!p || !fs.existsSync(p)) return new Response('not found', { status: 404 })
      return net.fetch(pathToFileURL(p).href)
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })
}

try {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'huiyou-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }])
} catch (e) {
  console.warn('[scheme]', e)
}

// 固定数据目录，避免 setName 改品牌后换盘导致话术/设置丢失
try {
  const stable = path.join(app.getPath('appData'), 'huiyou-original-shell')
  app.setPath('userData', stable)
} catch (e) { console.warn('[userData]', e) }

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    setPanelVisible(true)
  })

  app.whenReady().then(async () => {
    try { app.setName(BRAND) } catch {}
    try { if (process.platform === 'win32') app.setAppUserModelId('com.arzopa.aikefu') } catch {}
    try { registerMediaProtocol() } catch (e) { console.warn('[media protocol]', e) }

    await startStaticServer()
    wireIpc()
    store.getDataDir()
    createPanelWindow()
    createTray()
    registerHotkeys()
    if (store.loadSettings().feishuSyncOnLaunch) {
      handleCommand('sync_company_from_feishu').catch(() => console.warn('[feishu] 启动同步失败'))
    }

    if (win32.isWin()) {
      win32.ensureDaemon().then(() => console.log('[shell] win32 daemon ready')).catch((e) => console.warn('[shell] win32 daemon', e))
      stopSnap = startSnapLoop({
        getPanelWindow: () => panelWindow,
        getRuntime: () => runtime,
        setTarget: (t, opts) => {
          const prev = runtime.target
          runtime.target = t
          if (typeof t?.bound === 'boolean') runtime.pinned = !!t.bound
          if (opts?.emit) emitAll('target-changed', runtime.target)
          else if (opts?.emit === false) { /* silent rect refresh */ }
          else if (!prev || prev.hwnd !== t?.hwnd || prev.title !== t?.title || prev.bound !== t?.bound) {
            emitAll('target-changed', runtime.target)
          }
        },
        emitTarget: (t) => emitAll('target-changed', t),
      })
      console.log('[shell] snap/follow loop started')
    }

    console.log('[shell] dataDir', store.getDataDir())
    console.log('[shell] ready — AI客服')
  })

  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll() } catch { /* ignore */ }
    try { stopSnap?.() } catch { /* ignore */ }
    try { win32.dispose() } catch { /* ignore */ }
    try { staticServer?.close() } catch { /* ignore */ }
  })

  app.on('window-all-closed', () => {
    // keep tray; don't quit on Windows/Linux when panel hidden
    if (process.platform === 'darwin') app.quit()
  })
}
