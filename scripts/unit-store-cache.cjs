'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-store-cache-'))
const filename = path.resolve('electron/store.js')
const realRequire = createRequire(filename)
let reads = 0, writes = 0
const spyFs = { ...fs,
  readFileSync(...args) { reads++; return fs.readFileSync(...args) },
  writeFileSync(...args) { writes++; return fs.writeFileSync(...args) },
}
const context = { module: { exports: {} }, process, console, structuredClone,
  require: id => id === 'electron' ? { app: { getPath: () => dir } } : id === 'node:fs' ? spyFs : realRequire(id) }
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
const store = context.module.exports
const first = store.loadSettings()
assert.equal(writes, 1)
first.panel.chatApps.length = 0
first.send.mode = 'mutated'
const second = store.loadSettings()
assert.equal(reads, 0, 'freshly saved settings are already cached')
assert.ok(second.panel.chatApps.length > 0)
assert.equal(second.send.mode, 'send')
store.updateSettings({ panel: { docked: true, floatHeight: 600 } })
assert.equal(store.loadSettings().panel.docked, true)
assert.equal(store.loadSettings().panel.floatHeight, 600)
assert.equal(reads, 0, 'updateSettings uses and refreshes the cache')
const settingsFile = path.join(dir, 'huiyou-original-shell', 'settings.json')
fs.writeFileSync(settingsFile, JSON.stringify({ panel: { docked: true, floatHeight: 640 }, theme: 'external-edit' }))
const updatedTime = new Date(Date.now() + 2000)
fs.utimesSync(settingsFile, updatedTime, updatedTime)
const external = store.loadSettings()
assert.equal(reads, 1)
assert.equal(external.theme, 'external-edit')
assert.equal(external.panel.docked, false)
assert.equal(external.panel.floatHeight, 832)
const settledWrites = writes
store.loadSettings(); store.loadSettings()
assert.equal(reads, 1, 'unchanged file must not be read again')
assert.equal(writes, settledWrites, 'migration writes back only once')
const saved = store.defaultSettings()
store.saveSettings(saved)
saved.panel.side = 'left'
assert.equal(store.loadSettings().panel.side, 'right', 'save caller cannot mutate cached object')
console.log('unit-store-cache: PASS (isolated temp data; no real userData accessed)')
