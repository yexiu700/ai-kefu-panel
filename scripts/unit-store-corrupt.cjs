'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-store-corrupt-'))
const filename = path.resolve(__dirname, '../electron/store.js')
const realRequire = createRequire(filename)

let failCopy = false
const spyFs = {
  ...fs,
  copyFileSync(src, dest, ...rest) {
    if (failCopy && String(dest).includes('library-corrupt-')) {
      const err = new Error('ENOSPC: no space left on device')
      err.code = 'ENOSPC'
      throw err
    }
    return fs.copyFileSync(src, dest, ...rest)
  },
}

const silentConsole = {
  ...console,
  warn() {},
  error() {},
}

const context = {
  module: { exports: {} },
  process,
  console: silentConsole,
  structuredClone,
  require: (id) =>
    id === 'electron'
      ? { app: { getPath: () => dir } }
      : id === 'node:fs'
        ? spyFs
        : realRequire(id),
}
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
const store = context.module.exports

try {
  // 1. Missing library.json initializes empty library without corrupt backup
  const initial = store.loadLibrary()
  assert.equal(Array.isArray(initial.groups), true)
  const backupsDir = path.join(store.getDataDir(), 'backups')
  assert.deepEqual(
    fs.readdirSync(backupsDir).filter((f) => f.includes('corrupt')),
    [],
    'fresh init must not create corrupt backup',
  )

  // 2. Save a valid library so a normal .json backup also exists
  store.saveLibrary({
    version: 2,
    groups: [
      {
        id: 'g-after-sale',
        name: '售后',
        scope: 'private',
        phrases: [{ id: 'p1', title: '退货地址', content: '广东省深圳市南山区...' }],
      },
    ],
    stickers: [],
  })
  assert.equal(store.listBackups().length, 1)

  // 3. Truncated / corrupt library.json must be preserved in backups before reset
  const corruptRaw = '{"version":2,"groups":[{"id":"g1","name":"重要话术","phrases":[{"title":"未写完'
  fs.writeFileSync(store.libraryPath(), corruptRaw, 'utf8')

  const fallback = store.loadLibrary()
  assert.equal(Array.isArray(fallback.groups), true)
  assert.equal(fallback.groups.length, 0, 'returns usable default empty library')

  const corruptFiles = fs
    .readdirSync(backupsDir)
    .filter((f) => f.startsWith('library-corrupt-') && f.endsWith('.json.bak'))
  assert.equal(corruptFiles.length, 1, 'corrupt library.json must be copied into backups/')
  assert.equal(
    fs.readFileSync(path.join(backupsDir, corruptFiles[0]), 'utf8'),
    corruptRaw,
    'preserved corrupt file must contain exact original bytes',
  )

  // Subsequent loadLibrary() must not duplicate corrupt backup
  store.loadLibrary()
  assert.equal(
    fs.readdirSync(backupsDir).filter((f) => f.startsWith('library-corrupt-')).length,
    1,
    'healed library.json must not create duplicate corrupt backups',
  )

  // listBackups() only lists restorable .json files, and pruneBackups(2) never deletes .json.bak
  for (let i = 0; i < 4; i++) {
    store.backupNow(2)
  }
  const listed = store.listBackups()
  assert.equal(listed.every((b) => b.fileName.endsWith('.json')), true)
  assert.equal(
    fs.existsSync(path.join(backupsDir, corruptFiles[0])),
    true,
    'pruneBackups rotation must never delete preserved corrupt file',
  )

  // 4. If copying corrupt file fails (e.g. ENOSPC), do NOT overwrite library.json on disk
  const unbackedCorruptRaw = '<<<corrupt-when-disk-full>>>'
  fs.writeFileSync(store.libraryPath(), unbackedCorruptRaw, 'utf8')
  failCopy = true
  const inMemoryFallback = store.loadLibrary()
  failCopy = false
  assert.equal(Array.isArray(inMemoryFallback.groups), true)
  assert.equal(
    fs.readFileSync(store.libraryPath(), 'utf8'),
    unbackedCorruptRaw,
    'must never overwrite corrupt library.json if backup copy failed',
  )

  // 5. Non-object JSON root (e.g. [] or null) is also preserved rather than silently wiped
  fs.writeFileSync(store.libraryPath(), 'null', 'utf8')
  const nullRootFallback = store.loadLibrary()
  assert.equal(Array.isArray(nullRootFallback.groups), true)
  assert.equal(
    fs.readdirSync(backupsDir).filter((f) => f.startsWith('library-corrupt-')).length,
    2,
    'non-object JSON root must also be preserved in backups/',
  )

  console.log('unit-store-corrupt: PASS')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
