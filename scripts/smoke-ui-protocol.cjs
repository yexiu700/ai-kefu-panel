'use strict'
// A separate test harness, never the application's main entry or real userData.
const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const run = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', timeout: 30000, windowsHide: true })
  process.stdout.write(run.stdout || '')
  process.stderr.write(run.stderr || '')
  if (run.error) console.error(run.error)
  process.exit(run.status === 0 ? 0 : 1)
} else {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const os = require('node:os')
  const { app, protocol, net, BrowserWindow, ipcMain } = require('electron')
  const { createUiHandler } = require('../electron/ui-protocol')
  const root = path.resolve(__dirname, '..')
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-protocol-smoke-')))
  app.disableHardwareAcceleration()
  app.on('window-all-closed', () => {})
  protocol.registerSchemesAsPrivileged(['aikefu', 'huiyou-media'].map(scheme => ({
    scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  })))
  let win
  const timeout = setTimeout(() => { console.error('protocol smoke timed out'); app.exit(1) }, 20000)
  app.whenReady().then(async () => {
    const requests = []
    const serve = createUiHandler(path.join(root, 'frontend'), url => net.fetch(url))
    protocol.handle('aikefu', request => { requests.push(new URL(request.url).pathname); return serve(request) })
    protocol.handle('huiyou-media', () => new Response('media-fixture'))
    const settings = { theme: 'light', panel: {}, send: {}, hotkeys: {} }
    ipcMain.handle('tauri-invoke', (_event, { cmd }) => {
      if (cmd === 'smoke_echo') return 'ipc-ok'
      if (cmd === 'get_settings') return settings
      if (cmd === 'get_assist_state') return { phase: 'idle' }
      if (cmd === 'get_library') return { groups: [{ id: 'fixture', name: 'fixture', scope: 'company',
        phrases: [{ id: 'fixture', title: 'fixture', content: 'fixture', images: [], files: [] }] }] }
      return null
    })
    win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: false, backgroundThrottling: false, additionalArguments: ['--window-label=panel'],
    } })
    win.webContents.on('preload-error', (_event, _file, error) => console.error('preload:', error))
    await win.loadURL('aikefu://ui/index.html?label=panel')
    const result = await win.webContents.executeJavaScript(`(async () => {
      const T = window.__TAURI_INTERNALS__;
      const ipc = await T.invoke('smoke_echo');
      const json = await (await fetch('/panel/default-company-library.json')).json();
      const css = await fetch('/brand-theme.css');
      const media = await (await fetch('huiyou-media://localhost/?p=fixture')).text();
      await new Promise((resolve, reject) => {
        const end = performance.now() + 6000;
        function check() {
          if (window.pinyinPro && document.querySelector('#list')?.textContent.includes('fixture')) resolve();
          else if (performance.now() > end) reject(new Error('panel render / deferred pinyin failed: ' + document.body.innerText.slice(0, 300)));
          else setTimeout(check, 40);
        } check();
      });
      window.__smokeEvent = new Promise(resolve => {
        const id = T.transformCallback(resolve);
        T.invoke('plugin:event|listen', { event: 'smoke-event', handler: id });
      });
      const chunk = await import('/assets/TemplatesPage-BlVodupk.js');
      return { ipc, json: !!json, css: css.status, chunk: Object.keys(chunk).length, media,
        label: T.metadata.currentWindow.label };
    })()`)
    assert.equal(result.ipc, 'ipc-ok')
    assert.equal(result.json, true)
    assert.equal(result.css, 200)
    assert.ok(result.chunk > 0)
    assert.equal(result.media, 'media-fixture')
    assert.equal(result.label, 'panel')
    win.webContents.send('tauri-event', { event: 'smoke-event', payload: 'event-ok' })
    assert.equal((await win.webContents.executeJavaScript('window.__smokeEvent')).payload, 'event-ok')
    win.destroy()
    requests.length = 0
    win = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: false, backgroundThrottling: false, additionalArguments: ['--window-label=manager'],
    } })
    await win.loadURL('aikefu://ui/manager.html?label=manager')
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const end = performance.now() + 5000;
      function check() {
        const nav = document.querySelector('[data-testid="nav-templates"]');
        if (nav) resolve();
        else if (performance.now() > end) reject(new Error('manager boot failed'));
        else setTimeout(check, 40);
      } check();
    })`)
    assert.ok(!requests.some(url => url.includes('TemplatesPage-')), 'Templates chunk and CSS remain lazy')
    assert.ok(requests.some(url => url.includes('GuideSpotlight-')), 'shared runtime still loads eagerly')
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-testid="nav-templates"]').click();
      await new Promise((resolve, reject) => {
        const end = performance.now() + 5000;
        function check() {
          const css = [...document.styleSheets].some(s => s.href?.includes('TemplatesPage-'));
          if (css && document.querySelector('[data-testid="nav-templates"]').getAttribute('data-active') === 'true') resolve();
          else if (performance.now() > end) reject(new Error('Templates route / CSS failed'));
          else setTimeout(check, 40);
        } check();
      });
    })()`)
    assert.ok(requests.some(url => url.includes('TemplatesPage-') && url.endsWith('.js')))
    assert.ok(requests.some(url => url.includes('TemplatesPage-') && url.endsWith('.css')))
    console.log('smoke-ui-protocol: PASS (isolated Electron panel/manager, preload/IPC/events, fetch, pinyin, lazy Templates/CSS, media)')
    clearTimeout(timeout)
    win.destroy()
    app.exit(0)
  }).catch(error => { console.error(error); clearTimeout(timeout); if (win) win.destroy(); app.exit(1) })
}
