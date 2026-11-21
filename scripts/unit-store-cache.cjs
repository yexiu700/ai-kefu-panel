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
const settingsFile = path.join(dir, 'ai-kefu-panel', 'settings.json')
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

// Corrupt settings.json must be preserved to backups/ before falling back to defaults
const corruptSettingsRaw = '{not valid json'
fs.writeFileSync(settingsFile, corruptSettingsRaw, 'utf8')
const corruptTime = new Date(Date.now() + 4000)
fs.utimesSync(settingsFile, corruptTime, corruptTime)
const fallbackSettings = store.loadSettings()
assert.equal(fallbackSettings.send.mode, 'send')
const backupsDir = path.join(dir, 'ai-kefu-panel', 'backups')
const corruptSettingsFiles = fs.readdirSync(backupsDir).filter((f) => f.startsWith('settings-corrupt-') && f.endsWith('.json.bak'))
assert.equal(corruptSettingsFiles.length, 1, 'corrupt settings.json must be preserved in backups/')
assert.equal(fs.readFileSync(path.join(backupsDir, corruptSettingsFiles[0]), 'utf8'), corruptSettingsRaw)

// loadLibrary caching: repeated calls do not re-read unchanged library.json, and external edits invalidate cache
const readsBeforeLib = reads
store.saveLibrary({ version: 1, groups: [{ id: 'g1', name: '售前', scope: 'company', phrases: [{ id: 'p1', title: '你好', content: '欢迎' }] }], stickers: [] }, { skipBackup: true })
const lib1 = store.loadLibrary()
assert.equal(reads, readsBeforeLib, 'freshly saved library is served from cache without disk read')
lib1.groups[0].name = 'mutated'
const lib2 = store.loadLibrary()
assert.equal(reads, readsBeforeLib, 'repeated loadLibrary must hit cache')
assert.equal(lib2.groups[0].name, '售前', 'cached library returns deep clone')

const libFile = path.join(dir, 'ai-kefu-panel', 'library.json')
fs.writeFileSync(libFile, JSON.stringify({ version: 1, groups: [{ id: 'g2', name: '外部修改', scope: 'company', phrases: [] }], stickers: [] }))
const libTime = new Date(Date.now() + 6000)
fs.utimesSync(libFile, libTime, libTime)
const lib3 = store.loadLibrary()
assert.equal(reads, readsBeforeLib + 1, 'external library edit must invalidate cache')
assert.equal(lib3.groups[0].name, '外部修改')

fs.rmSync(dir, { recursive: true, force: true })
console.log('unit-store-cache: PASS (settings + library cache, corrupt settings backup, isolated temp data)')
