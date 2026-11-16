'use strict'
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const win32 = require('../electron/win32')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-paste-030-'))
const wait = ms => new Promise(r => setTimeout(r, ms))
const fixture = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'media-paste-fixture.ps1'), '-TestDir', dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
fixture.stderr.on('data', b => process.stderr.write(b))
async function read(name) {
  for (let i = 0; i < 100; i++) {
    try { return fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '').trim() } catch { await wait(100) }
  }
  throw new Error('fixture timeout: ' + name)
}
async function main() {
  const hwnd = Number(await read('hwnd.txt'))
  const paths = [path.join(dir, '图片.png'), path.join(dir, '中文附件.txt')]
  fs.writeFileSync(paths[0], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
  fs.writeFileSync(paths[1], 'test attachment')
  const copied = await win32.writeFileClipboard(paths)
  assert.equal(copied.ok, true)
  assert.equal(copied.format, 'CF_HDROP')
  const r = await win32.sendKeys(hwnd, { mode: 'fill', media: true, delayMs: 80, clipboardSequence: copied.clipboardSequence })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.verify, 'unavailable')
  const received = JSON.parse(await read('received.json'))
  assert.equal(received.count, 2)
  assert.deepEqual(received.paths, paths)
  assert.equal(received.text, '', 'file clipboard must not be a textual list of paths')
  const missing = await win32.writeFileClipboard([path.join(dir, 'missing.pdf')])
  assert.equal(missing.ok, false)
  const changed = await win32.writeFileClipboard([paths[0]])
  assert.equal(changed.ok,true)
  const stopped = await win32.sendKeys(hwnd,{mode:'fill',media:true,clipboardSequence:copied.clipboardSequence})
  assert.equal(stopped.ok,false)
  assert.equal(stopped.error,'clipboard-changed')
  assert.equal(stopped.sendKeysOk,false)
  console.log('PASS: native persistent CF_HDROP, two Unicode local files received by controlled window Ctrl+V, unavailable, missing-file rejection; fixture=' + dir)
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(async () => {
  fs.writeFileSync(path.join(dir, 'stop'), '')
  win32.dispose()
  if (fixture.exitCode === null) await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{fixture.kill();reject(new Error('fixture cleanup timeout'))},15000)
    fixture.once('exit',()=>{clearTimeout(timer);resolve()})
  })
})
