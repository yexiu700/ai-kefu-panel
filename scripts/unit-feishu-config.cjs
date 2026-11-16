'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { randomUUID } = require('node:crypto')
const config = require('../electron/feishu-config')
const sync = require('../electron/feishu-sync')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-feishu-config-029-'))
const target = path.join(temp, 'config', 'feishu.env'), source = path.join(temp, 'source.env')
const secret = randomUUID(), appId = 'cli_' + randomUUID()
const env = { HUIYOU_FEISHU_APP_SECRET: 'outdated', AIKEFU_FEISHU_APP_ID: 'outdated' }
assert.equal(config.status(target, {}).configured, false)
fs.mkdirSync(path.dirname(target))
fs.writeFileSync(target, '# keep comment\nOTHER=keep\nHUIYOU_FEISHU_APP_ID=outdated\nHUIYOU_FEISHU_APP_SECRET=outdated\nAIKEFU_FEISHU_OVERSEAS_TABLE_ID=keep-table\n')
fs.writeFileSync(source, `\uFEFF# import\nexport AIKEFU_FEISHU_APP_ID="${appId}"\nAIKEFU_FEISHU_APP_SECRET='${secret}'\nHUIYOU_FEISHU_DOMESTIC_TABLE_ID=explicit-table\nHUIYOU_FEISHU_BASE_TOKEN=ignore\nUNRELATED=ignore\n`)
const result = config.importFile(source, target, env)
assert.equal(result.ok, true)
assert.ok(!JSON.stringify(result).includes(secret))
assert.ok(!JSON.stringify(result).includes(appId))
assert.ok(fs.readFileSync(target, 'utf8').includes('# keep comment\nOTHER=keep'))
assert.ok(!fs.readFileSync(target, 'utf8').includes('BASE_TOKEN=ignore'))
assert.ok(!fs.readFileSync(target, 'utf8').includes('UNRELATED'))
const resolved = sync.resolveConfig({}, env, 'domestic', target)
assert.equal(resolved.appId, appId); assert.equal(resolved.appSecret, secret)
assert.equal(resolved.tableId, 'explicit-table')
assert.equal(sync.resolveConfig({}, {}, 'overseas', target).tableId, 'keep-table')
const before = fs.readFileSync(target)
config.importFile(source, target, env); assert.deepEqual(fs.readFileSync(target), before)
for (const invalid of ['invalid text', 'AIKEFU_FEISHU_APP_ID=only', 'AIKEFU_FEISHU_APP_ID="unclosed', 'AIKEFU_FEISHU_APP_ID=\0', `AIKEFU_FEISHU_APP_ID=${appId}\nAIKEFU_FEISHU_APP_SECRET=`]) {
  fs.writeFileSync(source, invalid)
  assert.throws(() => config.importFile(source, target, env))
  assert.deepEqual(fs.readFileSync(target), before)
}
fs.writeFileSync(source, `AIKEFU_FEISHU_APP_ID=${appId}\nAIKEFU_FEISHU_APP_SECRET=${secret}\n`)
for (const method of ['writeFileSync', 'renameSync']) {
  const original = fs[method]
  fs[method] = () => { throw Object.assign(new Error(secret), { code: 'EACCES' }) }
  try {
    assert.throws(() => config.importFile(source, target, env), error => {
      assert.ok(!config.publicError(error).includes(secret)); return true
    })
  } finally { fs[method] = original }
  assert.deepEqual(fs.readFileSync(target), before)
}
assert.match(config.publicError({ code: 'ENOENT' }), /不存在/)
assert.match(config.publicError({ code: 'ENOSPC' }), /空间不足/)
assert.match(sync.validateConfig({}), /设置.*飞书同步配置/)
console.log('PASS: whitelist, aliases, regions, comments, repeat import, masking, immediate reload, invalid input, write/rename failure preserves original (temporary files only)')
