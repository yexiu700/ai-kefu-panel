'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const panel = fs.readFileSync('frontend/panel/panel.js', 'utf8').replace(/\r\n/g, '\n')
function section(start, end) {
  const from = panel.indexOf(start)
  assert.ok(from >= 0, start)
  const to = panel.indexOf(end, from)
  assert.ok(to > from, end)
  return panel.slice(from, to)
}

async function main() {
  const notices = [], copies = [], used = [], closed = []
  let target = true, result = { ok: true }, failure = null, loads = 0
  const ui = {
    window: { SendErrors: require('../frontend/panel/send-errors.js') },
    S: { busyId: null, aiDraft: 'reply', settings: {} },
    hasTarget: () => target,
    copyText: async text => copies.push(text),
    toast: (msg, kind) => notices.push({ msg, kind }),
    bumpUsage() {}, countUse: id => used.push(id), renderList() {},
    aiClose: () => closed.push(true),
    loadLibrary: async () => { loads++ },
    invoke: async () => { if (failure) throw failure; return result },
  }
  vm.runInNewContext(
    section('  async function usePhrase(', '  async function saveLibrary(') +
    section('  async function aiUse(', '  // 收录：') +
    section('  async function syncFeishu(', '  async function loadLibrary(') +
    panel.slice(panel.indexOf('function sendFailureMessage(')) +
    ';let syncingFeishu=false;globalThis.api={usePhrase,aiUse,syncFeishu}', ui)
  const phrase = { id: 'p', content: 'text' }
  for (const verify of ['match', 'unavailable']) {
    result = { ok: true, verify }
    for (const mode of ['copy', 'fill', 'send']) {
      await ui.api.usePhrase(phrase, mode)
      await ui.api.aiUse(mode)
    }
  }
  assert.equal(notices.length, 0, 'successful copy/fill/send must be quiet, including unverified success')
  assert.equal(used.length, 4, 'successful phrase usage still counted')
  assert.equal(closed.length, 4, 'successful AI use still closes the editor')

  // Issue #2: paste-unconfirmed (verify === 'mismatch' after sendKeysOk) must NOT pop diagnostic toast
  for (const unconfirmed of [
    { ok: false, sendKeysOk: true, verify: 'mismatch', error: 'Paste verification mismatch' },
    { ok: false, sendKeysOk: true, verify: 'mismatch', message: '粘贴未确认成功，内容已保留在剪贴板，请手动粘贴或增加延迟' },
  ]) {
    result = unconfirmed
    const beforeCopies = copies.length
    const beforeClosed = closed.length
    await ui.api.usePhrase(phrase, 'fill')
    await ui.api.usePhrase(phrase, 'send')
    await ui.api.aiUse('fill')
    await ui.api.aiUse('send')
    assert.equal(notices.length, 0, 'paste-unconfirmed diagnostic mismatch must not trigger toast')
    assert.equal(copies.length - beforeCopies, 4, 'unconfirmed paste keeps text in clipboard as silent safety net')
    assert.equal(closed.length - beforeClosed, 2, 'AI box still closes after paste keys were sent')
  }

  target = false
  await ui.api.usePhrase(phrase, 'fill'); await ui.api.aiUse('send')
  assert.deepEqual(notices.splice(0).map(n => n.kind), ['warn', 'warn'])
  target = true
  for (const response of [{ ok: true, unbound: true }, { ok: true, mode: 'clipboard' }, { ok: false, error: 'activation failed' }]) {
    result = response
    const before = copies.length
    await ui.api.usePhrase(phrase, 'fill'); await ui.api.aiUse('send')
    assert.equal(copies.length - before, 2, 'manual fallback/failure must still copy the text')
    const kept = notices.splice(0)
    assert.deepEqual(kept.map(n => n.kind), response.ok ? ['warn', 'warn'] : ['err', 'err'])
    if (!response.ok) assert.ok(kept.every(n => n.msg.includes('Target activation failed')))
  }
  result = { ok: false, hasMedia: true, message: 'media failed' }
  const beforeMedia = copies.length
  await ui.api.usePhrase({ ...phrase, images: ['image'] }, 'send')
  assert.equal(copies.length, beforeMedia, 'media fallback clipboard must not be overwritten')
  assert.equal(notices.pop().kind, 'err')
  failure = new Error('offline')
  const beforeFailure = copies.length
  await ui.api.usePhrase(phrase, 'send'); await ui.api.aiUse('fill')
  assert.equal(copies.length - beforeFailure, 2)
  assert.deepEqual(notices.splice(0).map(n => n.kind), ['err', 'err'])
  failure = null
  ui.S.aiDraft = ''
  await ui.api.aiUse('send')
  assert.equal(notices.pop().kind, 'warn', 'empty reply validation remains visible')
  result = { ok: true, message: 'synced' }
  await ui.api.syncFeishu('domestic')
  assert.equal(loads, 1)
  assert.equal(notices.length, 0, 'sync progress and success must be quiet')
  result = { ok: false, message: 'sync failed' }
  await ui.api.syncFeishu('overseas')
  assert.deepEqual(notices.pop(), { msg: 'sync failed', kind: 'err' })
  failure = new Error('offline')
  await ui.api.syncFeishu('domestic')
  assert.equal(notices.pop().kind, 'err')

  const el = { hidden: true }, timers = []
  const toastUi = { $: () => el, clearTimeout() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length } }
  const toastCode = section('  let toastTimer =', '\n  }\n')
  vm.runInNewContext(toastCode + '\n  };globalThis.toast=toast', toastUi)
  for (const kind of [undefined, '', 'success', 'info']) toastUi.toast('quiet', kind)
  assert.equal(el.hidden, true)
  assert.equal(timers.length, 0)
  for (const [kind, ms] of [['err', 3600], ['warn', 2200]]) {
    toastUi.toast('visible', kind)
    assert.equal(el.hidden, false)
    assert.equal(el.className, 'toast ' + kind)
    assert.equal(timers.at(-1).ms, ms)
    timers.at(-1).fn(); assert.equal(el.hidden, true)
  }

  const bundle = fs.readFileSync('frontend/assets/GuideSpotlight-Bc_qirTp.js', 'utf8')
  const manager = { gn: value => ({ value }), setTimeout: () => 1, clearTimeout() {} }
  vm.runInNewContext(bundle.slice(bundle.indexOf('const xf={info:'), bundle.indexOf('const Jh=Symbol(')) + ';globalThis.toasts=jf()', manager)
  manager.toasts.success('saved'); manager.toasts.info('copied')
  assert.equal(manager.toasts.items.value.length, 0)
  manager.toasts.error('failed')
  assert.equal(manager.toasts.items.value.length, 1)
  assert.equal(manager.toasts.items.value[0].level, 'error')
  manager.toasts.dismiss(manager.toasts.items.value[0].id)
  assert.equal(manager.toasts.items.value.length, 0)
  console.log('PASS: quiet panel operations and sync; fallback clipboard, errors, warnings, timers and manager error toasts preserved')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
