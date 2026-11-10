import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sync = require('../electron/feishu-sync.js')
const fs = require('node:fs')
const config = { appId: 'mock-id', appSecret: 'mock-secret', baseToken: 'mock-base', tableId: 'mock-table' }
const row = (id, fields = {}) => ({ record_id: id, fields: { 归属: '公司话术', 分组: '售前', 二级分类: '问候', 标题: id, 内容: '测试内容', ...fields } })
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`通过：${name}`)
}

await test('飞书单元格形状提取', () => {
  assert.equal(sync.cellText(null), '')
  assert.equal(sync.cellText([{ text: '欢迎' }, { value: [{ name: '咨询' }] }]), '欢迎咨询')
  assert.equal(sync.cellText({ link: 'https://example.com' }), 'https://example.com')
  assert.equal(sync.cellText(0), '0')
  assert.equal(sync.cellText(false), 'false')
  assert.equal(sync.cellText({ unknown: 'ignored' }), '')
})

await test('归属映射及跳过私人、小组', () => {
  for (const value of ['', '公司话术', '公司', 'company']) assert.equal(sync.mapScopeLabel(value), 'company')
  for (const value of ['私人话术', '私人', '个人', 'private']) assert.equal(sync.mapScopeLabel(value), 'private')
  for (const value of ['小组话术', '小组']) assert.notEqual(sync.mapScopeLabel(value), 'company')
  const result = sync.mapRecordsToCompanyGroups([row('c'), row('p', { 归属: '私人话术' }), row('s', { 归属: '小组' }), row('e', { 内容: '  ' })])
  assert.equal(result.phrasesSynced, 1)
  assert.equal(result.skipped, 3)
})

await test('稳定 ID、分类、标题颜色及重复同步', () => {
  const records = [row('rec1', { 内容: [{ text: '第一行\n' }, { text: '第二行' }], 标题颜色: '#ff0000' }), row('rec2')]
  const first = sync.mapRecordsToCompanyGroups(records)
  const again = sync.mapRecordsToCompanyGroups(records)
  assert.deepEqual(first, again)
  assert.equal(first.groups.length, 1)
  assert.equal(first.groups[0].sections.length, 1)
  const phrase = first.groups[0].phrases[0]
  assert.equal(phrase.id, 'feishu:rec1')
  assert.equal(phrase.content, '第一行\n第二行')
  assert.equal(phrase.titleColor, '#ff0000')
  assert.equal(phrase.section, first.groups[0].sections[0].id)
})

await test('热键保留首条并避开私人及全局热键', () => {
  const mapped = sync.mapRecordsToCompanyGroups([
    row('first', { 热键: 'Ctrl+1' }), row('duplicate', { 热键: 'ctrl+1' }), row('reserved', { 热键: 'Ctrl+2' }),
  ], ['ctrl+2'])
  assert.equal(mapped.groups[0].phrases[0].hotkey, 'Ctrl+1')
  assert.ok(!mapped.groups[0].phrases[1].hotkey)
  assert.ok(!mapped.groups[0].phrases[2].hotkey)
  assert.equal(mapped.hotkeyCleared.length, 2)
})

const privateGroup = { id: 'private', scope: 'private', phrases: [{ id: 'p', hotkey: 'Ctrl+8', favorite: true }] }
const library = {
  groups: [privateGroup, { id: 'legacy', phrases: [{ hotkey: 'Ctrl+1' }] }, { id: 'company', scope: 'company', phrases: [] }, { id: 'old-squad', scope: 'squad', phrases: [] }],
  stickers: [{ id: 'sticker' }], favorites: ['p'], custom: { retained: true },
}

await test('替换所有非 private 公司分组并保留私人、收藏和表情', () => {
  const before = structuredClone(library)
  const groups = sync.mapRecordsToCompanyGroups([row('new')]).groups
  const result = sync.replaceCompanyGroups(library, groups)
  assert.equal(result.groupsReplaced, 3)
  assert.deepEqual(result.library.groups.map(g => g.id), ['private', groups[0].id])
  assert.deepEqual(result.library.groups[0], privateGroup)
  assert.deepEqual(result.library.stickers, library.stickers)
  assert.deepEqual(result.library.favorites, library.favorites)
  assert.deepEqual(result.library.custom, library.custom)
  assert.deepEqual(library, before)
  assert.deepEqual(sync.localNonCompanyHotkeys(library), ['Ctrl+8'])
})

await test('鉴权请求及分页完整读取', async () => {
  let calls = 0
  const mock = async (url, init) => {
    calls++
    if (calls === 1) {
      assert.match(url, /tenant_access_token\/internal$/)
      assert.deepEqual(JSON.parse(init.body), { app_id: config.appId, app_secret: config.appSecret })
      return response({ code: 0, tenant_access_token: 'mock-token' })
    }
    assert.equal(init.headers.Authorization, 'Bearer mock-token')
    if (calls === 2) return response({ code: 0, data: { items: [row('page1')], has_more: true, page_token: 'next page' } })
    assert.equal(new URL(url).searchParams.get('page_token'), 'next page')
    return response({ code: 0, data: { items: [row('page2')], has_more: false } })
  }
  const result = await sync.syncCompanyFromFeishu({ config, library, fetchImpl: mock })
  assert.equal(calls, 3)
  assert.equal(result.result.ok, true)
  assert.equal(result.result.phrasesSynced, 2)
  assert.equal(result.library.groups.flatMap(g => g.phrases).filter(p => p.id.startsWith('feishu:')).length, 2)
})

await test('缺少密钥不发网络请求、不更改本地数据', async () => {
  const before = structuredClone(library)
  const result = await sync.syncCompanyFromFeishu({ config: { ...config, appSecret: '' }, library, fetchImpl: () => { throw Error('不应请求') } })
  assert.equal(result.result.ok, false)
  assert.equal(result.library, null)
  assert.match(result.result.message, /App|密钥|配置/)
  assert.deepEqual(library, before)
})

await test('配置优先级：进程变量及别名优先，文件次之，设置和默认值兜底', () => {
  const exists = fs.existsSync
  const read = fs.readFileSync
  const fakePath = 'offline-fixture-feishu.env'
  try {
    fs.existsSync = file => file === fakePath ? true : exists(file)
    fs.readFileSync = (file, ...args) => file === fakePath
      ? '# offline fixture\nHUIYOU_FEISHU_APP_ID="file-id"\nAIKEFU_FEISHU_APP_SECRET=\'file-secret\'\n'
      : read(file, ...args)
    const settings = { feishuAppId: 'settings-id', feishuAppSecret: 'settings-secret', feishuDomesticTableId: 'settings-table' }
    const fromFile = sync.resolveConfig(settings, {}, 'domestic', fakePath)
    assert.equal(fromFile.appId, 'file-id')
    assert.equal(fromFile.appSecret, 'file-secret')
    assert.equal(fromFile.tableId, 'settings-table')
    const fromEnv = sync.resolveConfig(settings, { HUIYOU_FEISHU_APP_ID: 'env-id', AIKEFU_FEISHU_APP_ID: 'alias-id', AIKEFU_FEISHU_APP_SECRET: 'alias-secret', AIKEFU_FEISHU_DOMESTIC_BASE_TOKEN: 'alias-base' }, 'domestic', fakePath)
    assert.equal(fromEnv.appId, 'env-id')
    assert.equal(fromEnv.appSecret, 'alias-secret')
    assert.equal(fromEnv.baseToken, 'alias-base')
    fs.existsSync = () => false
    const fromSettings = sync.resolveConfig(settings, {}, 'domestic', fakePath)
    assert.equal(fromSettings.appId, 'settings-id')
    assert.equal(fromSettings.appSecret, 'settings-secret')
    const defaults = sync.resolveConfig({}, {}, 'domestic', fakePath)
    assert.equal(defaults.baseToken, 'E6cZbMS57aJWyis3SV3c7cFInKh')
    assert.equal(defaults.tableId, 'tblBEtFX7gsg8CKX')
  } finally {
    fs.existsSync = exists
    fs.readFileSync = read
  }
})

await test('403、表不存在、Secret 错误和网络错误为中文', async () => {
  for (const [mockResponse, expected] of [
    [response({}, 403), /协作者|权限/],
    [response({ code: 1254041 }), /不存在|Table/],
    [response({ code: 10014 }), /Secret|密钥/],
  ]) {
    const result = await sync.syncCompanyFromFeishu({ config, library, fetchImpl: async () => mockResponse })
    assert.equal(result.result.ok, false)
    assert.equal(result.library, null)
    assert.match(result.result.message, expected)
  }
  const result = await sync.syncCompanyFromFeishu({ config, library, fetchImpl: async () => { throw Error('offline') } })
  assert.equal(result.library, null)
  assert.match(result.result.message, /网络|连接|飞书/)
})

await test('无公司内容及分页中途失败均保留原库', async () => {
  for (const failedPage of [false, true]) {
    let calls = 0
    const before = structuredClone(library)
    const result = await sync.syncCompanyFromFeishu({ config, library, fetchImpl: async () => {
      calls++
      if (calls === 1) return response({ code: 0, tenant_access_token: 'token' })
      if (calls === 2) return response({ code: 0, data: { items: [row('private', { 归属: '私人' })], has_more: failedPage, page_token: 'next' } })
      throw Error('offline')
    } })
    assert.equal(result.result.ok, false)
    assert.equal(result.library, null)
    assert.deepEqual(library, before)
  }
})

await test('更新飞书内容时保留稳定 ID 对应的本地收藏与使用记录', async () => {
  const local = { groups: [{ scope: 'company', phrases: [{ id: 'feishu:existing', content: '旧内容', favorite: true, useCount: 12, lastUsedAt: '2026-11-08' }] }], stickers: [] }
  let calls = 0
  const result = await sync.syncCompanyFromFeishu({ config, library: local, fetchImpl: async () => {
    calls++
    return calls === 1 ? response({ code: 0, tenant_access_token: 'token' })
      : response({ code: 0, data: { items: [row('existing', { 内容: '飞书新内容' })], has_more: false } })
  } })
  assert.equal(result.result.ok, true)
  const phrase = result.library.groups[0].phrases[0]
  assert.equal(phrase.content, '飞书新内容')
  assert.equal(phrase.favorite, true)
  assert.equal(phrase.useCount, 12)
  assert.equal(phrase.lastUsedAt, '2026-11-08')
  assert.equal(local.groups[0].phrases[0].content, '旧内容')
})

await test('双区域预设、记忆区域及区域覆盖隔离', () => {
  const missing = 'nonexistent-feishu-unit-fixture.env'
  const domestic = sync.resolveConfig({}, {}, 'domestic', missing)
  const overseas = sync.resolveConfig({}, {}, 'overseas', missing)
  assert.equal(domestic.baseToken, 'E6cZbMS57aJWyis3SV3c7cFInKh')
  assert.equal(domestic.tableId, 'tblBEtFX7gsg8CKX')
  assert.equal(overseas.baseToken, 'Bjesbt2qsa7lMqsN9a4cAhYZnHc')
  assert.equal(overseas.tableId, 'tblZuZMdLWMClcJW')
  assert.equal(sync.resolveConfig({}, {}, undefined, missing).region, 'domestic')
  assert.equal(sync.resolveConfig({ feishuLibraryRegion: 'overseas' }, {}, undefined, missing).region, 'overseas')
  assert.equal(sync.resolveConfig({ feishuLibraryRegion: 'overseas' }, {}, 'domestic', missing).region, 'domestic')
  const env = {
    HUIYOU_FEISHU_APP_ID: 'shared-id', AIKEFU_FEISHU_APP_SECRET: 'shared-secret',
    HUIYOU_FEISHU_DOMESTIC_BASE_TOKEN: 'domestic-env', AIKEFU_FEISHU_DOMESTIC_TABLE_ID: 'domestic-table',
    AIKEFU_FEISHU_OVERSEAS_BASE_TOKEN: 'overseas-alias', HUIYOU_FEISHU_OVERSEAS_TABLE_ID: 'overseas-table',
    HUIYOU_FEISHU_BASE_TOKEN: 'legacy-must-not-leak', HUIYOU_FEISHU_TABLE_ID: 'legacy-table',
  }
  for (const region of ['domestic', 'overseas']) {
    const cfg = sync.resolveConfig({}, env, region, missing)
    assert.equal(cfg.appId, 'shared-id')
    assert.equal(cfg.appSecret, 'shared-secret')
    assert.equal(cfg.baseToken, region === 'domestic' ? 'domestic-env' : 'overseas-alias')
    assert.equal(cfg.tableId, region + '-table')
  }
  const settings = { feishuOverseasBaseToken: 'settings-overseas', feishuOverseasTableId: 'settings-table' }
  assert.equal(sync.resolveConfig(settings, {}, 'overseas', missing).baseToken, 'settings-overseas')
  assert.equal(sync.resolveConfig(settings, {}, 'overseas', missing).tableId, 'settings-table')
  assert.equal(sync.resolveConfig(settings, {}, 'domestic', missing).baseToken, domestic.baseToken)
})

await test('双区域同步参数、目标表及结果标签，保留私人和表情', async () => {
  for (const region of ['domestic', 'overseas']) {
    const cfg = sync.resolveConfig({ feishuAppId: 'id', feishuAppSecret: 'secret' }, {}, region, 'nonexistent-feishu-unit-fixture.env')
    let calls = 0
    const before = structuredClone(library)
    const result = await sync.syncCompanyFromFeishu({ config: cfg, region, library, fetchImpl: async url => {
      if (++calls === 1) return response({ code: 0, tenant_access_token: 'token' })
      assert.ok(url.includes(`/apps/${cfg.baseToken}/tables/${cfg.tableId}/records`))
      return response({ code: 0, data: { items: [row(region)], has_more: false } })
    } })
    assert.equal(result.result.ok, true)
    assert.equal(result.result.region, region)
    assert.ok(result.result.message.includes(region === 'domestic' ? '国内' : '海外'))
    assert.equal(result.result.phrasesSynced, 1)
    assert.deepEqual(result.library.groups.find(g => g.scope === 'private'), privateGroup)
    assert.deepEqual(result.library.stickers, library.stickers)
    assert.deepEqual(library, before)
  }
})

console.log(`飞书同步离线测试全部通过：${passed} 项`)
