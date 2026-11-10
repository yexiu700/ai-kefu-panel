'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const events = [], logs = []
let response = { ok: true, sendKeysOk: true, verify: 'unavailable' }
let clipboardResponse = {ok:true}
const filename = path.resolve('electron/send.js'), real = createRequire(filename)
const mocks = {
  electron: { clipboard: { readText: () => 'old', writeText: t => events.push(['text', t]) } },
  './media': { preparePhraseMedia: p => ({ paths: p.paths || p.images || [], errors: p.errors || [] }) },
  './send-log': { appendSendLog: r => logs.push(r) },
  './win32': {
    writeFileClipboard: async paths => { events.push(['files', ...paths]); return clipboardResponse },
    sendKeys: async (h, opts) => { events.push(['paste', opts.media === true, opts.mode]); return response },
  },
}
const sandbox = { module: { exports: {} }, require: id => mocks[id] || real(id), process: { platform: 'win32' }, console, setTimeout: fn => setTimeout(fn, 0) }
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox)
async function main() {
  const sender = sandbox.module.exports
  assert.equal(typeof sender.sendPhrase, 'function', 'phrase sender must carry media into clipboard/paste chain')
  let r = await sender.sendPhrase({ content: 'hello', images: ['image.png', 'file.pdf'] }, { hwnd: 1, mode: 'fill' })
  assert.equal(r.hasMedia, true)
  assert.equal(r.verify, 'unavailable')
  assert.deepEqual(events.filter(e => e[0] !== 'text' || e[1] !== 'old'), [['text', 'hello'], ['paste', false, 'fill'], ['files', 'image.png', 'file.pdf'], ['paste', true, 'fill']])
  assert.equal(events.at(-1)[0], 'paste', 'unverified file clipboard must remain available, never restore old text')
  assert.equal(logs.at(-1).hasMedia, true)
  assert.equal(logs.at(-1).verify, 'unavailable')
  assert.equal(logs.at(-1).pasteConfirmed, null)
  assert.ok(logs.at(-1).verifyReason)
  events.length = 0
  r = await sender.sendPhrase({ content: 'manual', images: ['a.png'] }, {})
  assert.equal(r.unbound, true)
  assert.deepEqual(events, [['files', 'a.png']])
  assert.match(r.message, /手动粘贴/)
  events.length = 0
  r = await sender.sendPhrase({ content: '', images: ['good'], errors: ['文件不存在'] }, { hwnd: 1 })
  assert.equal(r.ok, false)
  assert.match(r.message, /文件不存在/)
  assert.ok(events.some(e => e[0] === 'paste'))
  events.length = 0
  response = { ok: false, error: 'elevation-mismatch' }
  r = await sender.sendPhrase({ content: '', images: ['a'] }, { hwnd: 1 })
  assert.match(r.message, /管理员/)
  assert.equal(events.at(-1)[0], 'paste')
  events.length = 0
  response = { ok: true, sendKeysOk: true, verify: 'unavailable' }
  await sender.sendPhrase({ content: 'send', images: ['a'] }, { hwnd: 1, mode: 'send', key: 'ctrl_enter', pasteDelayMs: 650 })
  assert.deepEqual(events.filter(e => e[0] === 'paste').map(e => e[2]), ['send', 'send'])
  assert.equal(logs.at(-1).pasteDelayMs, 650)
  assert.equal(logs.at(-1).key, 'ctrl_enter')
  events.length = 0
  await Promise.all([sender.sendPhrase({ content: 'one', images: ['1'] }, {hwnd:1}), sender.sendPhrase({ content: 'two', images: ['2'] }, {hwnd:1})])
  assert.deepEqual(events.filter(e=>e[0]==='files').map(e=>e[1]), ['1','2'])
  assert.ok(events.findIndex(e=>e[0]==='files'&&e[1]==='1') < events.findIndex(e=>e[0]==='text'&&e[1]==='two'))
  // Execute the actual panel function to catch clipboard-only early exits and overwrites.
  const panel = fs.readFileSync('frontend/panel/panel.js', 'utf8')
  let copied = 0, invoked = 0, target = false, panelResult = {ok:true,hasMedia:true,unbound:true,message:'手动粘贴'}
  const ui = { S:{busyId:null},hasTarget:()=>target,copyText:async()=>{copied++},bumpUsage(){},toast(){},renderList(){},countUse(){},sendFailureMessage:r=>r.message,invoke:async()=>{invoked++;return panelResult} }
  vm.runInNewContext(panel.slice(panel.indexOf('  async function usePhrase('),panel.indexOf('  async function saveLibrary('))+';globalThis.use=usePhrase',ui)
  const phrase={id:'p',content:'text',images:['a']}
  await ui.use(phrase,'fill')
  assert.equal(invoked,1)
  assert.equal(copied,0,'unbound media must not be replaced by text')
  target=true;panelResult={ok:false,hasMedia:true,message:'无法粘贴'}
  await ui.use(phrase,'send')
  assert.equal(copied,0,'failed media must not be replaced by text')
  events.length=0
  r=await sender.sendPhrase({images:['missing'],paths:[],errors:['文件不存在']},{hwnd:1})
  assert.equal(r.ok,false)
  assert.equal(events.length,0)
  assert.equal(logs.at(-1).verify,'skipped')
  clipboardResponse={ok:false,message:'剪贴板被占用'}
  r=await sender.sendPhrase({images:['valid']},{hwnd:1})
  assert.equal(r.ok,false)
  assert.match(r.message,/剪贴板被占用/)
  assert.equal(logs.at(-1).sendKeysOk,false)
  console.log('PASS: media clipboard, text-first ordering, fill/send, unbound preservation, partial errors, elevation and unavailable logging')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
