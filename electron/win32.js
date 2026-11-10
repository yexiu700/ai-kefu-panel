'use strict'
/**
 * Windows Win32 bridge via a long-lived PowerShell daemon.
 * No-ops / empty results on non-Windows.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const { EventEmitter } = require('node:events')

function daemonScript() {
  // PowerShell cannot -File a script inside app.asar; use asar.unpacked when packaged
  const base = __dirname.includes('app.asar')
    ? __dirname.replace('app.asar', 'app.asar.unpacked')
    : __dirname
  return path.join(base, 'win32-daemon.ps1')
}
const SCRIPT = daemonScript()

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let child = null
let starting = null
let reqId = 0
const pending = new Map()
const bus = new EventEmitter()
let buffer = ''

function isWin() {
  return process.platform === 'win32'
}

function ensureDaemon() {
  if (!isWin()) return Promise.resolve(null)
  if (child && !child.killed) return Promise.resolve(child)
  if (starting) return starting
  starting = new Promise((resolve, reject) => {
    try {
      const c = spawn(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      child = c
      buffer = ''
      c.stdout.setEncoding('utf8')
      c.stderr.setEncoding('utf8')
      c.stdout.on('data', (chunk) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          // FIFO: one request → one response
          const first = pending.keys().next()
          if (!first.done) {
            const id = first.value
            const entry = pending.get(id)
            pending.delete(id)
            entry.resolve(msg)
          } else {
            bus.emit('orphan', msg)
          }
        }
      })
      c.stderr.on('data', (d) => {
        const t = String(d).trim()
        if (t) console.warn('[win32:stderr]', t.slice(0, 400))
      })
      c.on('exit', (code) => {
        console.warn('[win32] daemon exited', code)
        child = null
        for (const [, entry] of pending) entry.reject(new Error('win32 daemon exited'))
        pending.clear()
      })
      c.on('error', (err) => {
        console.warn('[win32] spawn error', err)
        child = null
        reject(err)
      })
      // warm ping
      setTimeout(() => {
        request({ op: 'ping' }, 5000).then(() => resolve(c)).catch((e) => {
          try { c.kill() } catch { /* ignore */ }
          child = null
          reject(e)
        })
      }, 50)
    } catch (e) {
      starting = null
      reject(e)
    }
  }).finally(() => { starting = null })
  return starting
}

function request(payload, timeoutMs = 8000) {
  if (!isWin()) return Promise.resolve({ ok: false, error: 'not-windows' })
  return ensureDaemon().then(() => new Promise((resolve, reject) => {
    if (!child || !child.stdin.writable) {
      reject(new Error('win32 daemon not ready'))
      return
    }
    const id = ++reqId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('win32 timeout: ' + payload.op))
    }, timeoutMs)
    pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    })
    try {
      child.stdin.write(JSON.stringify(payload) + '\n')
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e)
    }
  }))
}

async function listOpenApps() {
  if (!isWin()) return []
  try {
    const res = await request({ op: 'list' }, 12000)
    if (!res?.ok) return []
    const apps = Array.isArray(res.apps) ? res.apps : []
    return apps
      .filter((a) => a && a.hwnd != null)
      .map((a) => ({
        hwnd: Number(a.hwnd),
        title: String(a.title || ''),
        exe: String(a.exe || ''),
      }))
  } catch (e) {
    console.warn('[win32] listOpenApps', e)
    return []
  }
}

async function getForeground() {
  if (!isWin()) return null
  try {
    const res = await request({ op: 'fg' })
    return res?.window || null
  } catch {
    return null
  }
}

async function getWindowRect(hwnd) {
  if (!isWin() || !hwnd) return null
  try {
    const res = await request({ op: 'rect', hwnd: Number(hwnd) })
    return res?.window || null
  } catch {
    return null
  }
}

async function activateWindow(hwnd) {
  if (!isWin() || !hwnd) return false
  try {
    const res = await request({ op: 'activate', hwnd: Number(hwnd) })
    return !!res?.ok
  } catch {
    return false
  }
}

async function sendKeys(hwnd, { mode = 'send', key = 'enter', delayMs = 80, prefix = '', exe = '', media = false, focusInput = false, clipboardSequence = 0 } = {}) {
  if (!isWin()) return { ok: false, method: 'unsupported' }
  try {
    const res = await request({
      op: 'send',
      hwnd: hwnd ? Number(hwnd) : 0,
      mode,
      key,
      delayMs,
      prefix,
      exe,
      media,
      focusInput,
      clipboardSequence,
    }, Math.max(15000, Math.max(0, Math.min(10000, Number(delayMs) || 0)) * 2 + 8000))
    return { ...res, ok: !!res?.ok, method: res?.method || 'sendkeys', error: res?.error }
  } catch (e) {
    return { ok: false, method: 'sendkeys-failed', error: String(e) }
  }
}


async function getAppIcon(hwnd) {
  if (!isWin() || !hwnd) return new Uint8Array()
  try {
    const res = await request({ op: 'icon', hwnd: Number(hwnd) }, 10000)
    if (!res?.ok || !res.pngBase64) return new Uint8Array()
    return Buffer.from(String(res.pngBase64), 'base64')
  } catch (e) {
    console.warn('[win32] getAppIcon', e)
    return new Uint8Array()
  }
}

function dispose() {
  if (child) {
    try { child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n') } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    child = null
  }
}

module.exports = {
  writeFileClipboard: paths => request({ op: 'clipboard-files', paths }, 15000),
  isWin,
  ensureDaemon,
  listOpenApps,
  getForeground,
  getWindowRect,
  activateWindow,
  sendKeys,
  getAppIcon,
  dispose,
}
