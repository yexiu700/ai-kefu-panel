'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const panelSrc = fs.readFileSync(path.join(ROOT, 'frontend/panel/panel.js'), 'utf8')
const pinyinVendorSrc = fs.readFileSync(path.join(ROOT, 'frontend/panel/vendor/pinyin-pro.js'), 'utf8')

const utilStart = panelSrc.indexOf('  const esc =')
const utilEnd = panelSrc.indexOf('  let toastTimer =')
const listStart = panelSrc.indexOf('  const hasTarget =')
const listEnd = panelSrc.indexOf('  function paintActive(')

assert.ok(utilStart > 0 && utilEnd > utilStart, 'panel.js utility/pinyin slice anchors must exist')
assert.ok(listStart > 0 && listEnd > listStart, 'panel.js scoreFor/rowHtml slice anchors must exist')

const slicedCode =
  panelSrc.slice(utilStart, utilEnd) +
  '\n' +
  panelSrc.slice(listStart, listEnd) +
  '\nglobalThis.searchApi = { tokensOf, pyInfo, findToken, highlight, snippet, scoreFor, rowHtml, renderList };'

function createHarness() {
  const listEl = { innerHTML: '' }
  const sandbox = {
    SendRule: require('../frontend/panel/send-rule.js'),
    crypto: { randomUUID: () => 'test-uuid' },
    S: {
      library: { groups: [] },
      settings: { send: { mode: 'send', key: 'enter', appRules: [] } },
      target: { hwnd: 1001, exe: 'AliWorkbench.exe', title: '千牛接待台', bound: false },
      scope: 'company',
      q: '',
      favOnly: false,
      collapsed: new Set(),
      fqCollapsed: false,
      usage: {},
      rows: [],
      active: -1,
      busyId: null,
    },
    $: (sel) => (sel === '#list' ? listEl : { className: '', textContent: '', title: '' }),
    paintActive: () => {},
    console,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox

  // Load real bundled pinyin-pro into window.pinyinPro
  vm.runInNewContext(pinyinVendorSrc, sandbox, { filename: 'pinyin-pro.js' })
  assert.equal(typeof sandbox.pinyinPro?.pinyin, 'function', 'pinyin-pro vendor must expose window.pinyinPro.pinyin')

  vm.runInNewContext(slicedCode, sandbox, { filename: 'panel-search-slice.js' })
  return { api: sandbox.searchApi, S: sandbox.S, listEl }
}

const { api, S, listEl } = createHarness()

// 1. Title-only search invariant: scoreFor ONLY inspects p.title, NEVER p.content
{
  const phrase = {
    id: 'p1',
    title: '催付提醒',
    content: '亲，小店默认发顺丰包邮，支持七天无理由退货哦',
  }
  assert.equal(api.scoreFor(phrase, api.tokensOf('顺丰')), 0, 'body-only Chinese text must NOT match in scoreFor')
  assert.equal(api.scoreFor(phrase, api.tokensOf('shunfeng')), 0, 'body-only full pinyin must NOT match in scoreFor')
  assert.equal(api.scoreFor(phrase, api.tokensOf('sfby')), 0, 'body-only initials must NOT match in scoreFor')

  assert.ok(api.scoreFor(phrase, api.tokensOf('催付')) > 0, 'title literal must match')
  assert.ok(api.scoreFor(phrase, api.tokensOf('cuifu')) > 0, 'title full pinyin must match')
  assert.ok(api.scoreFor(phrase, api.tokensOf('cftx')) > 0, 'title initials must match')
  assert.equal(api.scoreFor(phrase, api.tokensOf('催付 顺丰')), 0, 'all tokens must hit title, never satisfied by body')

  const untitled = { id: 'p2', title: '', content: '顺丰包邮当天发货' }
  assert.equal(api.scoreFor(untitled, api.tokensOf('顺丰')), 0, 'untitled phrase must not match body text')
}

const plain = (v) => JSON.parse(JSON.stringify(v))

// 2. Full-pinyin character-start alignment & v-for-ü support
{
  // '你好' -> 'ni' + 'hao'
  const full = api.findToken('你好世界', 'nihao')
  assert.equal(full?.kind, 1)
  assert.deepEqual(plain(full?.ranges), [[0, 2]])

  // Partial trailing syllable starting at character boundary is allowed ('niha' -> '你好')
  const partial = api.findToken('你好世界', 'niha')
  assert.equal(partial?.kind, 1)
  assert.deepEqual(plain(partial?.ranges), [[0, 2]])

  // Starting from a later character's syllable boundary is allowed ('haoshi' -> '好世')
  const secondChar = api.findToken('你好世界', 'haoshi')
  assert.equal(secondChar?.kind, 1)
  assert.deepEqual(plain(secondChar?.ranges), [[1, 3]])

  // Mid-syllable substring NOT aligned to any character start MUST NOT match
  assert.equal(api.findToken('你好', 'ihao'), null, 'mid-syllable ihao must not match 你好')
  assert.equal(api.findToken('你好', 'ao'), null, 'mid-syllable ao must not match 你好')
  assert.equal(api.findToken('退货地址', 'uihuo'), null, 'mid-syllable uihuo must not match 退货')

  // v -> ü pinyin support ('绿色' -> 'lvse')
  const lv = api.findToken('绿色通道', 'lvse')
  assert.equal(lv?.kind, 1)
  assert.deepEqual(plain(lv?.ranges), [[0, 2]])
}

// 3. Initials matching in character order & Chinese highlight mapping
{
  const ini = api.findToken('退货地址', 'thdz')
  assert.equal(ini?.kind, 2)
  assert.deepEqual(plain(ini?.ranges), [[0, 4]])
  assert.equal(api.findToken('退货地址', 'dzth'), null, 'out-of-order initials must not match')

  // Highlight maps pinyin match ranges back onto original Chinese characters and escapes HTML
  const hl = api.highlight('退货<地址>', api.tokensOf('th'))
  assert.equal(hl, '<mark>退货</mark>&lt;地址&gt;')
}

// 4. Score ranking: literal start > literal middle > pinyin start > pinyin middle + usage tie-breaker
{
  const tok = api.tokensOf('vip')
  const startLiteral = { id: 'a', title: 'VIP专属客服', content: '1' }
  const midLiteral = { id: 'b', title: '联系VIP客服', content: '1' }
  assert.ok(api.scoreFor(startLiteral, tok) > api.scoreFor(midLiteral, tok))

  const pyTok = api.tokensOf('th')
  const pyStart = { id: 'c', title: '退货流程说明', content: '1' }
  const pyMid = { id: 'd', title: '七天退货说明', content: '1' }
  assert.ok(api.scoreFor(pyStart, pyTok) > api.scoreFor(pyMid, pyTok))

  const twin1 = { id: 'u1', title: '退货说明', content: '1' }
  const twin2 = { id: 'u2', title: '退货说明', content: '1' }
  S.usage.u2 = { n: 10, t: Date.now() }
  assert.ok(api.scoreFor(twin2, pyTok) > api.scoreFor(twin1, pyTok), 'frequently used phrase ranks higher on tie')
}

// 5. Title is NEVER truncated and NEVER gets ellipsis; long body snippet truncates & highlights
{
  const longTitle = '【大促售后必看】七天无理由退换货完整仓库收件地址与运费险理赔全流程指引超长标题绝不省略'
  const longBody = '尊敬的顾客您好，为了尽快帮您登记处理售后问题，请先核对包装完好无损并填写退货物流单号，仓库签收后24小时内极速退款'
  const group = { id: 'g1', name: '售后组', scope: 'company', phrases: [] }
  const phrase = { id: 'p-long', title: longTitle, content: longBody, images: [], files: [], favorite: false }
  group.phrases.push(phrase)
  S.library = { groups: [group] }
  S.q = 'thwl' // matches '退货物流' deep inside content for snippet/highlight, while let's search title token 'yfx' ('运费险')

  const row = api.rowHtml(phrase, group, 0, api.tokensOf('yfx'), true, false)
  assert.ok(row.includes('【大促售后必看】七天无理由退换货完整仓库收件地址与<mark>运费险</mark>理赔全流程指引超长标题绝不省略'), 'full title must be rendered with <mark> and zero truncation')
  const titleDivMatch = row.match(/<div class="t">([\s\S]*?)<\/div>/)
  assert.ok(titleDivMatch && !titleDivMatch[1].includes('…'), 'title container must never insert ellipsis')

  // Body snippet shifts window with leading ellipsis when match is past index 36
  const bodySnippet = api.snippet(longBody, api.tokensOf('极速退款'))
  assert.ok(bodySnippet.startsWith('…'), 'deep body match should produce leading ellipsis snippet')
  assert.ok(api.highlight(bodySnippet, api.tokensOf('jstk')).includes('<mark>极速退款</mark>'))

  // End-to-end renderList with query only hits title, never body-only query
  S.q = '极速退款' // exists only in longBody, NOT in longTitle
  api.renderList()
  assert.equal(S.rows.length, 0, 'renderList must return 0 hits when query only exists in phrase body')
  assert.ok(listEl.innerHTML.includes('没有找到'), 'empty search state rendered when only body has keyword')

  S.q = 'yfx' // '运费险' in longTitle
  api.renderList()
  assert.equal(S.rows.length, 1, 'renderList matches phrase via title pinyin initials')
  assert.equal(S.rows[0].p.id, 'p-long')
}

console.log('unit-search: PASS (title-only, full pinyin start alignment, initials, ranking, full title no-ellipsis)')
