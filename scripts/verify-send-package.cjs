'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const archive = path.resolve('dist/win-unpacked/resources/app.asar')
for (const file of ['frontend/panel/panel.js', 'frontend/panel/search.js', 'frontend/panel/send-errors.js', 'electron/handlers.js', 'electron/send.js', 'electron/send-log.js', 'electron/win32.js', 'electron/store.js']) {
  assert.deepEqual(asar.extractFile(archive, file.replaceAll('/', path.sep)), fs.readFileSync(file), file)
}
const panel = asar.extractFile(archive, ['frontend', 'panel', 'panel.js'].join(path.sep)).toString('utf8')
const sendErrors = asar.extractFile(archive, ['frontend', 'panel', 'send-errors.js'].join(path.sep)).toString('utf8')
for (const label of ['粘贴延迟', '恢复剪贴板', '打开发送日志']) assert.ok(panel.includes(label), label)
for (const label of ['elevation-mismatch', 'Target activation failed', '没能切到聊天窗', '管理员身份运行']) assert.ok(sendErrors.includes(label), label)
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, require('../package.json').version)
assert.deepEqual(fs.readFileSync('dist/win-unpacked/resources/app.asar.unpacked/electron/win32-daemon.ps1'), fs.readFileSync('electron/win32-daemon.ps1'))
console.log('PASS: packaged version, Chinese menu labels, runtime source files and unpacked daemon match')

