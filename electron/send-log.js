'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
function getLogDir() {
  return path.join(app.getPath('appData'), require('../package.json').productName, 'logs')
}
const LOG_RETENTION_DAYS = 30
let lastPruneKey = ''

function pruneOldSendLogs(dir, now = new Date(), retentionDays = LOG_RETENTION_DAYS) {
  const cutoffMs = now.getTime() - Math.max(1, retentionDays) * 86400000
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^send-(\d{4})(\d{2})(\d{2})\.log(?:\.1)?$/)
      if (!m) continue
      const fileDateMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      if (Number.isFinite(fileDateMs) && fileDateMs < cutoffMs) {
        try { fs.unlinkSync(path.join(dir, name)) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function appendSendLog(record, dir = getLogDir(), opts = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const now = opts.now instanceof Date ? opts.now : new Date()
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const pruneKey = `${dir}:${date}`
  if (pruneKey !== lastPruneKey) {
    lastPruneKey = pruneKey
    pruneOldSendLogs(dir, now, opts.retentionDays ?? LOG_RETENTION_DAYS)
  }
  const file = path.join(dir, `send-${date}.log`)
  if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1')
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  return file
}
module.exports = { getLogDir, appendSendLog, pruneOldSendLogs }
