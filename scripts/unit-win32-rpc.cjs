'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')

async function main() {
  const filename = path.resolve(__dirname, '../electron/win32.js')
  const realRequire = createRequire(filename)

  let fakeChild = null
  const writtenLines = []
  let onWrite = null

  function createFakeChild() {
    const c = new EventEmitter()
    c.killed = false
    c.stdout = new EventEmitter()
    c.stdout.setEncoding = () => {}
    c.stderr = new EventEmitter()
    c.stderr.setEncoding = () => {}
    c.stdin = {
      writable: true,
      write(chunk) {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const parsed = JSON.parse(line)
          writtenLines.push(parsed)
          onWrite?.(parsed, c)
        }
        return true
      },
    }
    c.kill = () => { c.killed = true }
    return c
  }

  const sandbox = {
    module: { exports: {} },
    __dirname: path.dirname(filename),
    process: { ...process, platform: 'win32' },
    console: { ...console, warn() {} },
    Buffer,
    Uint8Array,
    setTimeout,
    clearTimeout,
    require: (id) => {
      if (id === 'node:child_process') {
        return {
          spawn() {
            fakeChild = createFakeChild()
            return fakeChild
          },
        }
      }
      if (id === './win32-snapshot') {
        return { createSnapshotBackend: () => null }
      }
      return realRequire(id)
    },
  }

  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  const win32 = sandbox.module.exports

  // Auto-respond to warm ping with matching request id
  onWrite = (req, c) => {
    if (req.op === 'ping') {
      assert.equal(typeof req.id, 'number', 'every daemon request must carry a numeric id')
      c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, op: 'ping' }) + '\n')
    }
  }

  await win32.ensureDaemon()
  assert.ok(fakeChild, 'fake daemon spawned')

  // 1. Out-of-order + chunked responses + duplicate extra line for same request id must NOT cross-contaminate
  const queued = []
  onWrite = (req) => {
    queued.push(req)
  }

  const fgPromise = win32.getForeground()
  const rectPromise = win32.getWindowRect(888)
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(queued.length, 2)
  const [fgReq, rectReq] = queued
  assert.equal(fgReq.op, 'fg')
  assert.equal(rectReq.op, 'rect')
  assert.notEqual(fgReq.id, rectReq.id)

  // Emit rect response FIRST (in two partial TCP/pipe chunks), plus a duplicate line for rectReq.id, then fg response!
  const rectJson = JSON.stringify({
    id: rectReq.id,
    ok: true,
    window: { hwnd: 888, title: '京麦工作台', exe: 'JingMai.exe' },
  })
  fakeChild.stdout.emit('data', rectJson.slice(0, 18))
  fakeChild.stdout.emit('data', rectJson.slice(18) + '\n')
  // Accidental duplicate line with same id must become orphan, NOT resolve fgPromise!
  fakeChild.stdout.emit('data', JSON.stringify({ id: rectReq.id, ok: true, window: { hwnd: 999, title: '串台错误窗口' } }) + '\n')
  // Now emit actual fg response
  fakeChild.stdout.emit('data', JSON.stringify({
    id: fgReq.id,
    ok: true,
    window: { hwnd: 777, title: '千牛接待台', exe: 'AliWorkbench.exe' },
  }) + '\n')

  const [fgWin, rectWin] = await Promise.all([fgPromise, rectPromise])
  assert.equal(fgWin?.hwnd, 777, 'fg request must receive fg response matched by id, not duplicate/reordered rect response')
  assert.equal(fgWin?.title, '千牛接待台')
  assert.equal(rectWin?.hwnd, 888, 'rect request must receive rect response matched by id')

  // 2. Late response arriving AFTER a request timed out must NOT corrupt the next request
  let slowReq = null
  onWrite = (req, c) => {
    if (req.op === 'clipboard-files') {
      slowReq = req
      // Respond immediately after we simulate a stale late packet first
      setTimeout(() => {
        // Stale response from an old timed-out request id (e.g. id: 999999) arrives right before real response!
        c.stdout.emit('data', JSON.stringify({ id: 999999, ok: false, error: 'stale-timeout-response' }) + '\n')
        c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, count: 1, format: 'CF_HDROP', clipboardSequence: 42 }) + '\n')
      }, 5)
    }
  }

  const clipRes = await win32.writeFileClipboard(['C:\\temp\\a.png'])
  assert.ok(slowReq)
  assert.equal(clipRes.ok, true, 'stale response with non-matching id must be ignored rather than resolving active request')
  assert.equal(clipRes.clipboardSequence, 42)
  assert.equal('id' in clipRes, false, 'transport request id should be stripped from resolved payload')

  // 3. Verify win32-daemon.ps1 echoes request id in Write-Result
  const psSource = fs.readFileSync(path.resolve(__dirname, '../electron/win32-daemon.ps1'), 'utf8')
  assert.match(psSource, /\$script:currentReqId/, 'win32-daemon.ps1 must track current request id')
  assert.match(psSource, /\$req\.id/, 'win32-daemon.ps1 must read $req.id from incoming JSON')

  win32.dispose()
  console.log('unit-win32-rpc: PASS (request/response id correlation, duplicate/stale isolation, chunked framing)')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
