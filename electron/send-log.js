'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
function getLogDir() {
  return path.join(app.getPath('appData'), require('../package.json').productName, 'logs')
}
function appendSendLog(record, dir = getLogDir()) {
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date()
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const file = path.join(dir, `send-${date}.log`)
  if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1')
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  return file
}
module.exports = { getLogDir, appendSendLog }
