'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const panel = fs.readFileSync('frontend/panel/panel.js', 'utf8')
const html = fs.readFileSync('frontend/index.html', 'utf8')
assert.ok(!/<script[^>]+src=["'][^"']*pinyin-pro/.test(html), 'vendor must not block panel startup')
assert.ok(panel.includes('boot().then(schedulePinyinLoad)'), 'schedule only after boot has rendered the list')
const code = panel.slice(panel.indexOf('  let PY ='), panel.indexOf('  function highlight(')) +
  panel.slice(panel.indexOf('  function warmPinyin()'), panel.indexOf('  async function boot()')) +
  ';globalThis.api={findToken,warmPinyin,schedulePinyinLoad}'

function harness(withIdle = true) {
  const frames = [], idle = [], timers = [], scripts = [], warnings = []
  let renders = 0
  const ctx = {
    S: { q: 'nh', library: { groups: [{ phrases: [{ title: '你好', content: 'HELLO' }] }] } },
    window: withIdle ? { requestIdleCallback: cb => idle.push(cb) } : {},
    requestAnimationFrame: cb => frames.push(cb),
    setTimeout: cb => timers.push(cb),
    document: { createElement: () => ({}), head: { appendChild: script => scripts.push(script) } },
    renderList: () => renders++,
    console: { warn: message => warnings.push(message) },
  }
  vm.runInNewContext(code, ctx)
  return { ctx, frames, idle, timers, scripts, warnings, renders: () => renders }
}

for (const withIdle of [true, false]) {
  const h = harness(withIdle)
  const { api } = h.ctx
  assert.ok(api.findToken('HELLO', 'hello'), 'Latin search works before vendor loads')
  assert.ok(api.findToken('你好', '你好'), 'Chinese substring search works before vendor loads')
  assert.equal(api.findToken('你好', 'nh'), null)
  api.warmPinyin()
  assert.equal(h.idle.length + h.timers.length, 0, 'no fallback index warming before vendor loads')
  api.schedulePinyinLoad()
  assert.equal(h.scripts.length, 0)
  h.frames.shift()()
  assert.equal(h.scripts.length, 0, 'first frame still paints without vendor')
  h.frames.shift()()
  assert.equal(h.scripts.length, 0, 'wait for idle after paint')
  ;(withIdle ? h.idle : h.timers).shift()()
  assert.equal(h.scripts.length, 1)
  const script = h.scripts[0]
  assert.equal(script.src, '/panel/vendor/pinyin-pro.js')
  assert.equal(script.async, true)
  h.ctx.window.pinyinPro = { pinyin: text => Array.from(text, origin => ({
    origin, isZh: true, pinyin: origin === '你' ? 'ni' : 'hao',
  })) }
  script.onload()
  assert.ok(api.findToken('你好', 'nihao'), 'cached fallback is replaced with full pinyin')
  assert.ok(api.findToken('你好', 'nh'), 'initials enabled after load')
  assert.equal(h.renders(), 1, 'active query re-filters when vendor arrives')
  assert.equal(h.warnings.length, 0)
  api.schedulePinyinLoad()
  assert.equal(h.frames.length, 0, 'loaded vendor is not loaded again')
}

const failed = harness()
failed.ctx.api.schedulePinyinLoad()
failed.frames.shift()(); failed.frames.shift()(); failed.idle.shift()()
failed.scripts[0].onerror()
assert.equal(failed.warnings.length, 1)
assert.ok(failed.ctx.api.findToken('HELLO', 'hello'), 'failure preserves plain-text search')
assert.equal(failed.renders(), 0, 'failure does not report success or refresh unnecessarily')
failed.scripts[0].onload()
assert.equal(failed.warnings.length, 2, 'missing API after load is handled safely')

// warmPinyin must warm only titles (never body content) and cancel previous idle runs
const w = harness(true)
w.ctx.S.library = {
  groups: [{
    phrases: [
      { title: '退货政策', content: '很长的正文内容不应该被预热计算拼音以免撑爆缓存' },
      { title: '发货时效', content: '另一段很长的正文内容' },
    ],
  }],
}
const warmedInputs = []
w.ctx.window.pinyinPro = {
  pinyin: (text) => {
    warmedInputs.push(text)
    return Array.from(text, (origin) => ({ origin, isZh: true, pinyin: 'a' }))
  },
}
w.ctx.api.schedulePinyinLoad()
w.frames.shift()(); w.frames.shift()(); w.idle.shift()()
w.scripts[0].onload()
// Start a second warmPinyin before the first idle step runs: first run must be canceled
w.ctx.api.warmPinyin()
while (w.idle.length) {
  w.idle.shift()({ timeRemaining: () => 50 })
}
assert.deepEqual(warmedInputs, ['退货政策', '发货时效'], 'warmPinyin must warm titles only once and cancel stale chains')
assert.ok(!warmedInputs.some((t) => t.includes('正文')), 'warmPinyin must never waste CPU/cache on phrase body content')

console.log('unit-pinyin-lazy: ok (deferred scheduling, fallback, full pinyin, initials, failure, title-only warm + cancel)')
