'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function loadModule(relFile, mocks = {}, extraGlobals = {}) {
  const filename = path.resolve(relFile)
  const realRequire = createRequire(filename)
  const sandbox = {
    module: { exports: {} },
    __dirname: path.dirname(filename),
    require: (id) => (id in mocks ? mocks[id] : realRequire(id)),
    console: { ...console, warn() {}, log() {}, debug() {} },
    process,
    Buffer,
    Uint8Array,
    ArrayBuffer,
    structuredClone,
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    ...extraGlobals,
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return sandbox.module.exports
}

async function main() {
  // 1. llm.js: 401/403 and timeout must NOT waste a second call to /chat/completions; 404 falls back cleanly
  const llm = require('../electron/llm')
  const calls = []
  await assert.rejects(
    llm.callLlm(
      { baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'bad-key' },
      [{ role: 'user', content: 'hi' }],
      {
        retries: 0,
        fetchImpl: async (url) => {
          calls.push(url)
          return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'invalid key' } }) }
        },
      },
    ),
    /401/,
  )
  assert.deepEqual(calls, ['https://example.test/v1/responses'], '401 auth failure must not fall back to /chat/completions')

  calls.length = 0
  await assert.rejects(
    llm.callLlm(
      { baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      {
        retries: 0,
        timeoutMs: 25,
        fetchImpl: async (url, init) => {
          calls.push(url)
          return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => {
              const e = new Error('aborted')
              e.name = 'AbortError'
              reject(e)
            })
          })
        },
      },
    ),
    /超时/,
  )
  assert.deepEqual(calls, ['https://example.test/v1/responses'], 'timeout must not wait another full timeout on /chat/completions')

  calls.length = 0
  const fallbackReply = await llm.callLlm(
    { baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'k' },
    [{ role: 'user', content: 'hi' }],
    {
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.endsWith('/responses')) {
          return { ok: false, status: 404, text: async () => 'not found' }
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: 'fallback ok' } }] }),
        }
      },
    },
  )
  assert.equal(fallbackReply, 'fallback ok')
  assert.deepEqual(calls, ['https://example.test/v1/responses', 'https://example.test/v1/chat/completions'])

  // 2. assist.js: generation guard drops stale concurrent responses and discarded runs; emitter injection avoids circular require
  const emitted = []
  let resolvers = []
  const assist = loadModule('electron/assist.js', {
    electron: { clipboard: { readText: () => '买家问题1' } },
    './store': {
      getDataDir: () => os.tmpdir(),
      loadLibrary: () => ({ groups: [{ name: '售后', phrases: [{ id: 'p1', title: '退货', content: '支持7天无理由退货' }] }] }),
    },
    './llm': {
      resolveApiKey: () => 'sk-test-1234567890',
      maskKey: (k) => k.slice(0, 3) + '…' + k.slice(-2),
      callLlm: () => new Promise((resolve) => { resolvers.push(resolve) }),
    },
  })
  assist.setEmitter((ev, payload) => emitted.push([ev, payload]))

  const p1 = assist.assistAsk('第一个慢问题')
  const p2 = assist.assistAsk('第二个快问题')
  assert.equal(resolvers.length, 2)
  // Resolve second request first
  resolvers[1](JSON.stringify({ reply: '回复：第二个问题的答案', alternatives: ['备选A'] }))
  await p2
  assert.equal(assist.getAssistState().phase, 'ready')
  assert.equal(assist.getAssistState().result.reply, '第二个问题的答案')
  // Now resolve stale first request -> MUST NOT overwrite ready state of second question!
  resolvers[0](JSON.stringify({ reply: '过时的第一个回复' }))
  await p1
  assert.equal(assist.getAssistState().result.reply, '第二个问题的答案', 'stale AI response must not overwrite newer reply')

  // Discard while running must ignore late completion
  resolvers = []
  const p3 = assist.assistAsk('将被取消的问题')
  assist.assistDiscard()
  assert.equal(assist.getAssistState().phase, 'idle')
  resolvers[0](JSON.stringify({ reply: '取消后的迟到回复' }))
  await p3
  assert.equal(assist.getAssistState().phase, 'idle', 'discarded AI request must not revive card on late response')
  assert.ok(emitted.some(([ev]) => ev === 'assist-state'), 'injected emitter receives assist-state broadcasts')

  // 3. send-log.js: prunes logs older than 30 days while preserving recent ones
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-log-prune-'))
  const sendLog = loadModule('electron/send-log.js', {
    electron: { app: { getPath: () => logDir } },
  })
  fs.writeFileSync(path.join(logDir, 'send-20260101.log'), '{"old":true}\n')
  fs.writeFileSync(path.join(logDir, 'send-20260101.log.1'), '{"old":true}\n')
  fs.writeFileSync(path.join(logDir, 'send-20261115.log'), '{"recent":true}\n')
  fs.writeFileSync(path.join(logDir, 'unrelated.txt'), 'keep')
  sendLog.appendSendLog({ ok: true }, logDir, { now: new Date('2026-11-21T12:00:00Z'), retentionDays: 30 })
  assert.equal(fs.existsSync(path.join(logDir, 'send-20260101.log')), false, 'logs older than 30 days must be pruned')
  assert.equal(fs.existsSync(path.join(logDir, 'send-20260101.log.1')), false, 'rotated logs older than 30 days must be pruned')
  assert.equal(fs.existsSync(path.join(logDir, 'send-20261115.log')), true, 'recent logs must be retained')
  assert.equal(fs.existsSync(path.join(logDir, 'unrelated.txt')), true, 'non-send-log files must not be touched')
  fs.rmSync(logDir, { recursive: true, force: true })

  // 4. preload.js: plugin:event|unlisten cleans up callback map so callbacks do not leak
  const exposed = {}
  const ipcHandlers = {}
  loadModule('electron/preload.js', {
    electron: {
      contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v } },
      ipcRenderer: {
        on: (ch, fn) => { ipcHandlers[ch] = fn },
        send: () => {},
        invoke: async () => null,
      },
    },
  }, {
    location: { search: '?label=panel' },
    window: { addEventListener: () => {} },
    document: { createElement: () => ({}), documentElement: { appendChild: () => {} } },
  })
  const tauri = exposed.__TAURI_INTERNALS__
  let callsSeen = 0
  const cbId = tauri.transformCallback(() => { callsSeen++ })
  const eventId = await tauri.invoke('plugin:event|listen', { event: 'demo', handler: cbId })
  ipcHandlers['tauri-event'](null, { event: 'demo', payload: {} })
  assert.equal(callsSeen, 1)
  await tauri.invoke('plugin:event|unlisten', { event: 'demo', eventId })
  // Firing callback directly via tauri-run-callback after unlisten must do nothing because callback was cleaned up
  ipcHandlers['tauri-run-callback'](null, { id: cbId, data: {} })
  assert.equal(callsSeen, 1, 'unlisten must remove handler callback to prevent leaks')

  // 5. handlers.js: get_autostart reads OS login item settings; unknown stubs deduplicated; feishu merge punctuation clean
  let loginItemState = true
  const handlers = loadModule('electron/handlers.js', {
    electron: {
      app: { getLoginItemSettings: () => ({ openAtLogin: loginItemState }), setLoginItemSettings: (o) => { loginItemState = !!o.openAtLogin } },
      dialog: {},
      shell: {},
      clipboard: {},
      BrowserWindow: { getAllWindows: () => [] },
      nativeImage: {},
    },
    './store': { loadSettings: () => ({}), loadLibrary: () => ({ groups: [] }) },
    './media': {},
    './send': {},
    './send-log': {},
    './win32': {},
    './assist': { setEmitter() {} },
    './feishu-sync': require('../electron/feishu-sync'),
    './feishu-config': require('../electron/feishu-config'),
  })
  assert.equal(await handlers.handleCommand('get_autostart'), true, 'get_autostart must reflect actual OS login item state')
  await handlers.handleCommand('unknown_cmd_xyz')
  await handlers.handleCommand('unknown_cmd_xyz')
  assert.equal(handlers.runtime.stubs.filter((x) => x === 'unknown_cmd_xyz').length, 1, 'unknown stubs must not grow unbounded')

  const feishu = require('../electron/feishu-sync')
  const merged = feishu.mergeSyncedCompanyGroups(
    { groups: [{ id: 'p', scope: 'private', phrases: [{ id: 'p1', hotkey: 'Ctrl+1' }] }] },
    [{ id: 'c', scope: 'company', phrases: [{ id: 'feishu:1', title: '欢迎语', content: '您好', hotkey: 'Ctrl+1' }] }],
    [],
  )
  assert.deepEqual(merged.hotkeyCleared, ['欢迎语（Ctrl+1）'], 'cleared hotkey notice must use proper Chinese parentheses')

  console.log('unit-assist-llm: PASS (llm fallback guard, assist concurrency/discard, log pruning, preload unlisten cleanup, autostart, stubs dedupe)')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
