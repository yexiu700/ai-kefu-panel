'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const archive = path.resolve('dist/win-unpacked/resources/app.asar')
for (const file of ['frontend/panel/panel.js', 'electron/handlers.js', 'electron/send.js', 'electron/send-log.js', 'electron/win32.js', 'electron/store.js']) {
  assert.deepEqual(asar.extractFile(archive, file.replaceAll('/', path.sep)), fs.readFileSync(file), file)
}
const panel = asar.extractFile(archive, ['frontend','panel','panel.js'].join(path.sep)).toString('utf8')
for (const label of ['粘贴延迟','恢复剪贴板','打开发送日志','elevation-mismatch','Target activation failed','没能切到聊天窗','京东工作台以管理员运行']) assert.ok(panel.includes(label), label)
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, '0.2.27')
assert.deepEqual(fs.readFileSync('dist/win-unpacked/resources/app.asar.unpacked/electron/win32-daemon.ps1'), fs.readFileSync('electron/win32-daemon.ps1'))
console.log('PASS: packaged version, Chinese menu labels, five runtime source files and unpacked daemon match')

