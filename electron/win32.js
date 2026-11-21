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
let snapshotBackend

function rejectPendingForChild(targetChild, err) {
  for (const [id, entry] of pending) {
    if (!targetChild || entry.proc === targetChild) {
      pending.delete(id)
      entry.reject(err)
    }
  }
}

function sendRawRequest(targetChild, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!targetChild || targetChild.killed || !targetChild.stdin?.writable) {
      reject(new Error('win32 daemon not ready'))
      return
    }
    const id = ++reqId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('win32 timeout: ' + payload.op))
    }, timeoutMs)
    pending.set(id, {
      proc: targetChild,
      resolve: (msg) => { clearTimeout(timer); resolve(msg) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    })
    try {
      targetChild.stdin.write(JSON.stringify({ ...payload, id }) + '\n')
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e)
    }
  })
}

function nativeSnapshot(method, hwnd) {
  // undefined means unavailable: preserve the existing daemon fallback.
  if (snapshotBackend === undefined) {
    try { snapshotBackend = require('./win32-snapshot').createSnapshotBackend() }
    catch (e) {
      snapshotBackend = null
      console.warn('[win32] native snapshot unavailable; using daemon:', e.message)
    }
  }
  if (!snapshotBackend) return undefined
  try { return snapshotBackend[method](hwnd) }
  catch (e) {
    if (e?.transient || /Cannot read snapshot process name/i.test(String(e?.message || ''))) {
      return undefined
    }
    snapshotBackend = null
    console.warn('[win32] native snapshot failed; using daemon:', e.message)
    return undefined
  }
}

function isWin() {
  return process.platform === 'win32'
}

function ensureDaemon() {
  if (!isWin()) return Promise.resolve(null)
  if (starting) return starting
  if (child && !child.killed) return Promise.resolve(child)
  starting = new Promise((resolve, reject) => {
    let settled = false
    const finishResolve = (c) => {
      if (settled) return
      settled = true
      resolve(c)
    }
    const finishReject = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    try {
      const c = spawn(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let stdoutBuffer = ''
      c.stdout.setEncoding('utf8')
      c.stderr.setEncoding('utf8')
      c.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk
        let idx
        while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, idx).trim()
          stdoutBuffer = stdoutBuffer.slice(idx + 1)
          if (!line) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          if (msg && typeof msg === 'object' && msg.id != null) {
            const matchId = Number(msg.id)
            const entry = pending.get(matchId)
            if (entry && entry.proc === c) {
              pending.delete(matchId)
              const { id: _id, ...clean } = msg
              entry.resolve(clean)
            } else {
              bus.emit('orphan', msg)
            }
          } else {
            // Fallback for unattributed lines (e.g. malformed request JSON before id is parsed)
            let matchedId = null
            for (const [id, entry] of pending) {
              if (entry.proc === c) { matchedId = id; break }
            }
            if (matchedId !== null) {
              const entry = pending.get(matchedId)
              pending.delete(matchedId)
              entry.resolve(msg)
            } else {
              bus.emit('orphan', msg)
            }
          }
        }
      })
      c.stderr.on('data', (d) => {
        const t = String(d).trim()
        if (t) console.warn('[win32:stderr]', t.slice(0, 400))
      })
      c.on('exit', (code) => {
        console.warn('[win32] daemon exited', code)
        if (child === c) child = null
        const err = new Error('win32 daemon exited')
        rejectPendingForChild(c, err)
        finishReject(err)
      })
      c.on('error', (err) => {
        console.warn('[win32] spawn error', err)
        if (child === c) child = null
        rejectPendingForChild(c, err)
        finishReject(err)
      })
      // warm ping directly on this child before exposing it as ready
      setTimeout(() => {
        if (settled || c.killed) return
        sendRawRequest(c, { op: 'ping' }, 5000).then(() => {
          if (c.killed) {
            finishReject(new Error('win32 daemon killed during warmup'))
            return
          }
          child = c
          finishResolve(c)
        }).catch((e) => {
          try { c.kill() } catch { /* ignore */ }
          if (child === c) child = null
          finishReject(e)
        })
      }, 50)
    } catch (e) {
      starting = null
      finishReject(e)
    }
  }).finally(() => { starting = null })
  return starting
}

function request(payload, timeoutMs = 8000) {
  if (!isWin()) return Promise.resolve({ ok: false, error: 'not-windows' })
  return ensureDaemon().then((c) => sendRawRequest(c, payload, timeoutMs))
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
  const snapshot = nativeSnapshot('getForeground')
  if (snapshot !== undefined) return snapshot
  try {
    const res = await request({ op: 'fg' })
    return res?.window || null
  } catch {
    return null
  }
}

async function getWindowRect(hwnd) {
  if (!isWin() || !hwnd) return null
  const snapshot = nativeSnapshot('getWindowRect', hwnd)
  if (snapshot !== undefined) return snapshot
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
    const dying = child
    child = null
    try { dying.stdin.write(JSON.stringify({ op: 'quit' }) + '\n') } catch { /* ignore */ }
    try { dying.kill() } catch { /* ignore */ }
    rejectPendingForChild(dying, new Error('win32 daemon disposed'))
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
