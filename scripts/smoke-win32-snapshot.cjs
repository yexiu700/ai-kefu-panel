'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('SKIP: Windows snapshot smoke requires Windows')
  process.exit(0)
}
const backend = require('../electron/win32-snapshot').createSnapshotBackend()
const dpiContext = require('koffi').load('user32.dll').func('intptr_t __stdcall GetThreadDpiAwarenessContext()')
const dpiBefore = dpiContext()
assert.equal(backend.getWindowRect(0), null)
assert.equal(backend.getWindowRect(1), null)
const fg = backend.getForeground()
assert.equal(dpiContext(), dpiBefore, 'snapshot must restore the Electron thread DPI context')
if (fg) {
  assert.ok(Number.isSafeInteger(fg.hwnd) && fg.hwnd > 0)
  for (const name of ['left', 'top', 'right', 'bottom', 'width', 'height', 'pid']) {
    assert.equal(typeof fg[name], 'number', name)
  }
  assert.equal(typeof fg.visible, 'boolean')
  assert.equal(typeof fg.iconic, 'boolean')
  assert.equal(typeof fg.title, 'string')
  assert.equal(typeof fg.exe, 'string')
  // Compare the exact Get-WinInfo implementation without starting the app,
  // activating any window, touching the clipboard or reading user settings.
  const source = fs.readFileSync(path.join(__dirname, '../electron/win32-daemon.ps1'), 'utf8')
  const script = source.slice(0, source.indexOf('function List-OpenApps')) +
    `\nGet-WinInfo ([IntPtr]${fg.hwnd}) | ConvertTo-Json -Compress\n`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const daemon = JSON.parse(result.stdout.trim())
  const current = backend.getWindowRect(fg.hwnd)
  assert.ok(current, 'foreground window must still exist during smoke')
  assert.deepEqual(Object.keys(current).sort(), Object.keys(daemon).sort())
  assert.equal(current.pid, daemon.pid)
  assert.equal(current.exe.toLowerCase(), daemon.exe.toLowerCase())
  // The window can move during comparison; print whether the sampled rect agrees.
  const rectMatches = ['left', 'top', 'right', 'bottom'].every(key => current[key] === daemon[key])
  assert.ok(rectMatches, 'native and PowerShell coordinates should agree on a stationary window')
}
console.log(`PASS: native snapshot (${process.versions.electron ? 'Electron ' + process.versions.electron : 'Node ' + process.versions.node}); daemon field/coordinate parity; invalid hwnd`)
