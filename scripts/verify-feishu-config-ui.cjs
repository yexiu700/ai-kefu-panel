'use strict'
// Real renderer/preload/handlers; mocked native chooser, isolated home + userData.
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http')
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-feishu-ui-029-'))
os.homedir = () => temp
app.setPath('userData', temp)
for (const prefix of ['HUIYOU_FEISHU_', 'AIKEFU_FEISHU_']) {
  for (const name of ['APP_ID', 'APP_SECRET', 'DOMESTIC_BASE_TOKEN', 'DOMESTIC_TABLE_ID', 'OVERSEAS_BASE_TOKEN', 'OVERSEAS_TABLE_ID']) delete process.env[prefix + name]
}
app.whenReady().then(async () => {
  const { handleCommand } = require(path.join(root, 'electron/handlers.js'))
  const config = require(path.join(root, 'electron/feishu-config.js'))
  const store = require(path.join(root, 'electron/store.js'))
  const source = path.join(temp, 'source.env'), target = config.defaultPath()
  const secret = randomUUID(), appId = 'cli_' + randomUUID()
  let selected = source, permissionFailure = false, lastResponse, chooserCalls = 0
  dialog.showOpenDialog = async options => {
    chooserCalls++; assert.deepEqual(options.properties, ['openFile'])
    return selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] }
  }
  ipcMain.handle('tauri-invoke', async (_event, request) => {
    const rename = fs.renameSync
    if (permissionFailure && request.cmd === 'import_feishu_config') fs.renameSync = () => { throw Object.assign(new Error(secret), { code: 'EACCES' }) }
    try {
      const result = await handleCommand(request.cmd, request.args, {})
      if (request.cmd.includes('feishu_config')) {
        lastResponse = result
        assert.ok(!JSON.stringify(result).includes(secret), 'secret in IPC response')
        assert.ok(!JSON.stringify(result).includes(appId), 'full App ID in IPC response')
      }
      return result
    } finally { fs.renameSync = rename }
  })
  const server = http.createServer((req, res) => {
    const file = path.join(root, 'frontend', new URL(req.url, 'http://localhost').pathname)
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(fs.readFileSync(file))
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const win = new BrowserWindow({ show: false, width: 1100, height: 950, webPreferences: { preload: path.join(root, 'electron/preload.js'), sandbox: false, additionalArguments: ['--window-label=manager'] } })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async predicate => {
    for (let count = 0; count < 150; count++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error('UI condition timed out')
  }
  await win.loadURL(`http://127.0.0.1:${server.address().port}/manager.html?tab=settings`)
  await waitFor(() => run(`document.querySelector('[data-testid="feishu-config-status"]')?.textContent.includes('未配置')`))
  const clickImport = async () => {
    lastResponse = null
    await run(`document.querySelector('[data-testid="import-feishu-config"]').click()`)
    await waitFor(() => lastResponse !== null)
    await waitFor(() => run(`!document.querySelector('[data-testid="import-feishu-config"]').disabled`))
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '# preserve\nOTHER=keep\nHUIYOU_FEISHU_APP_SECRET=old\nAIKEFU_FEISHU_OVERSEAS_TABLE_ID=keep\n')
  fs.writeFileSync(source, `AIKEFU_FEISHU_APP_ID=${appId}\nAIKEFU_FEISHU_APP_SECRET=${secret}\n`)
  await clickImport(); assert.equal(lastResponse.ok, true)
  assert.ok((await run('document.body.innerText')).includes('当前进程可立即同步'))
  const saved = fs.readFileSync(target)
  await clickImport(); assert.deepEqual(fs.readFileSync(target), saved)
  assert.ok(!JSON.stringify(store.loadSettings()).includes(secret), 'secret in settings.json')
  assert.ok(!(await run('document.documentElement.outerHTML')).includes(secret), 'secret in renderer')
  fs.writeFileSync(source, 'invalid text')
  await clickImport(); assert.equal(lastResponse.ok, false); assert.match(lastResponse.message, /格式无效/)
  assert.deepEqual(fs.readFileSync(target), saved)
  fs.writeFileSync(source, 'OTHER=only')
  await clickImport(); assert.match(lastResponse.message, /缺少有效/)
  selected = path.join(temp, 'missing.env')
  await clickImport(); assert.match(lastResponse.message, /不存在/)
  selected = null
  await clickImport(); assert.equal(lastResponse.canceled, true)
  selected = source; permissionFailure = true
  fs.writeFileSync(source, `AIKEFU_FEISHU_APP_ID=${appId}\nAIKEFU_FEISHU_APP_SECRET=${secret}\n`)
  await clickImport(); assert.match(lastResponse.message, /权限/)
  assert.deepEqual(fs.readFileSync(target), saved)
  const message = require(path.join(root, 'electron/feishu-sync.js')).validateConfig({})
  assert.match(message, /设置.*飞书同步配置/)
  const shot = path.join(temp, 'settings.png')
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
  console.log('PASS: settings chooser + preload + IPC import, repeat, malformed/missing credentials/file, cancellation, permission failure, masked DOM/IPC, no settings secret; chooser calls=' + chooserCalls)
  console.log('Screenshot: ' + shot)
  win.destroy(); server.close(); app.quit()
}).catch(error => { console.error(error.message); app.exit(1) })
