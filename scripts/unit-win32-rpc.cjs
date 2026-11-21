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

  // 3. Verify win32-daemon.ps1 preserves UTF-8 BOM (required by Windows PowerShell 5.1) and echoes request id
  const psPath = path.resolve(__dirname, '../electron/win32-daemon.ps1')
  const psBytes = fs.readFileSync(psPath)
  assert.equal(
    psBytes[0] === 0xef && psBytes[1] === 0xbb && psBytes[2] === 0xbf,
    true,
    'electron/win32-daemon.ps1 MUST start with UTF-8 BOM (EF BB BF) for Windows PowerShell 5.1 compatibility',
  )
  const psSource = psBytes.toString('utf8')
  assert.match(psSource, /\$script:currentReqId/, 'win32-daemon.ps1 must track current request id')
  assert.match(psSource, /\$req\.id/, 'win32-daemon.ps1 must read $req.id from incoming JSON')
  assert.doesNotMatch(
    psSource,
    /\bStart-Sleep\b/,
    'win32-daemon.ps1 must avoid Start-Sleep cmdlet module autoload latency on the paste/focus path',
  )
  assert.match(
    psSource,
    /\[System\.Threading\.Thread\]::Sleep/,
    'win32-daemon.ps1 must use [System.Threading.Thread]::Sleep for deterministic sub-100ms waits',
  )
  assert.match(
    psSource,
    /function Find-RebindCandidate\b/,
    'win32-daemon.ps1 must isolate rebind matching into Find-RebindCandidate to prevent cross-app mis-rebind',
  )
  assert.match(
    psSource,
    /\$running\s*=\s*\$false/,
    'win32-daemon.ps1 quit command must terminate the outer read loop instead of only breaking switch',
  )

  win32.dispose()

  // 4. Transient snapshot error (e.g. elevated foreground window) must NOT permanently disable Koffi backend
  let snapshotCalls = 0
  let snapshotMode = 'elevated'
  let daemonFgCalls = 0
  const sandbox2 = {
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
            const c = createFakeChild()
            c.stdin.write = (chunk) => {
              for (const line of String(chunk).split('\n').filter(Boolean)) {
                const req = JSON.parse(line)
                if (req.op === 'ping') {
                  c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, op: 'ping' }) + '\n')
                } else if (req.op === 'fg') {
                  daemonFgCalls++
                  c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, window: { hwnd: 501, title: '管理员窗口', exe: 'Taskmgr.exe' } }) + '\n')
                }
              }
              return true
            }
            return c
          },
        }
      }
      if (id === './win32-snapshot') {
        return {
          createSnapshotBackend: () => ({
            getForeground() {
              snapshotCalls++
              if (snapshotMode === 'elevated') {
                const err = new Error('Cannot read snapshot process name')
                err.transient = true
                throw err
              }
              return { hwnd: 602, title: '微信', exe: 'WeChat.exe' }
            },
            getWindowRect: () => null,
          }),
        }
      }
      return realRequire(id)
    },
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox2, { filename })
  const win32Snap = sandbox2.module.exports
  const elevatedFg = await win32Snap.getForeground()
  assert.equal(elevatedFg?.hwnd, 501, 'transient snapshot error should fall back to daemon for this tick')
  assert.equal(daemonFgCalls, 1)
  snapshotMode = 'normal'
  const normalFg = await win32Snap.getForeground()
  assert.equal(normalFg?.hwnd, 602, 'Koffi snapshot backend must remain enabled after a transient elevated-window failure')
  assert.equal(snapshotCalls, 2)
  assert.equal(daemonFgCalls, 1, 'normal window must use Koffi without hitting daemon again')
  win32Snap.dispose()

  // 5. Concurrent requests during warmup must wait for ping; stale child exit must not corrupt new child
  const spawnedChildren = []
  let activeWriteHandler = null
  const sandbox3 = {
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
            const c = createFakeChild()
            c.stdin.write = (chunk) => {
              for (const line of String(chunk).split('\n').filter(Boolean)) {
                const req = JSON.parse(line)
                activeWriteHandler?.(req, c)
              }
              return true
            }
            spawnedChildren.push(c)
            return c
          },
        }
      }
      if (id === './win32-snapshot') return { createSnapshotBackend: () => null }
      return realRequire(id)
    },
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox3, { filename })
  const win32Life = sandbox3.module.exports

  const order = []
  let releasePing = null
  activeWriteHandler = (req, c) => {
    order.push(req.op)
    if (req.op === 'ping') {
      releasePing = () => c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, op: 'ping' }) + '\n')
    } else if (req.op === 'fg') {
      c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, window: { hwnd: 111, title: '窗1', exe: 'a.exe' } }) + '\n')
    }
  }
  const pWarm = win32Life.ensureDaemon()
  const pEarlyFg = win32Life.getForeground()
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(order, ['ping'], 'concurrent request during warmup must wait until warm ping completes')
  assert.ok(releasePing, 'warm ping must have been issued')
  releasePing()
  await pWarm
  const firstFg = await pEarlyFg
  assert.equal(firstFg?.hwnd, 111)
  assert.deepEqual(order, ['ping', 'fg'])
  assert.equal(spawnedChildren.length, 1)

  // Simulate old child disposed and replaced by a new child; delayed exit of old child must NOT break new child
  const oldChild = spawnedChildren[0]
  win32Life.dispose()
  activeWriteHandler = (req, c) => {
    if (req.op === 'ping') {
      c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, op: 'ping' }) + '\n')
    } else if (req.op === 'rect') {
      setTimeout(() => {
        c.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, window: { hwnd: 222, title: '新进程窗', exe: 'b.exe' } }) + '\n')
      }, 20)
    }
  }
  await win32Life.ensureDaemon()
  assert.equal(spawnedChildren.length, 2)
  const pendingRect = win32Life.getWindowRect(222)
  // Stale exit event fires from oldChild while newChild has an in-flight request
  oldChild.emit('exit', 1)
  const rectAfterStaleExit = await pendingRect
  assert.equal(rectAfterStaleExit?.hwnd, 222, 'stale exit from previous daemon must not reject active request of new daemon')
  win32Life.dispose()

  console.log('unit-win32-rpc: PASS (id correlation, transient Koffi fallback, warmup queue, stale exit isolation)')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
