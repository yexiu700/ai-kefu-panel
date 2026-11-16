'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log('SKIP: packaged snapshot smoke requires Windows x64')
    return
  }
  const root = path.resolve(__dirname, '..')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-snapshot-asar-'))
  const source = path.join(dir, 'source')
  fs.mkdirSync(path.join(source, 'electron'), { recursive: true })
  fs.copyFileSync(path.join(root, 'electron/win32-snapshot.js'), path.join(source, 'electron/win32-snapshot.js'))
  for (const name of ['koffi', '@koromix/koffi-win32-x64']) {
    fs.cpSync(path.join(root, 'node_modules', name), path.join(source, 'node_modules', name), { recursive: true })
  }
  const archive = path.join(dir, 'app.asar')
  await asar.createPackageWithOptions(source, archive, { unpackDir: 'node_modules/@koromix/koffi-win32-x64' })
  assert.ok(fs.existsSync(path.join(archive + '.unpacked', 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node')))
  const entry = path.join(dir, 'run.cjs')
  fs.writeFileSync(entry, `const b=require(${JSON.stringify(path.join(archive, 'electron/win32-snapshot.js'))}).createSnapshotBackend();b.getForeground();if(b.getWindowRect(0)!==null)throw new Error('invalid hwnd');console.log('PASS: asar native snapshot loaded under Electron '+process.versions.electron)`)
  // Run as an isolated Electron script; no application entrypoint or userData.
  const result = spawnSync(require('electron'), [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS: asar native snapshot/)
  console.log(result.stdout.trim())
}
main().catch(error => { console.error(error); process.exitCode = 1 })
