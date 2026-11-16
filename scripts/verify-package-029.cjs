'use strict'
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),asar=require('@electron/asar')
const archive=path.resolve('dist/win-unpacked/resources/app.asar')
const files=['electron/feishu-config.js','electron/media.js','electron/handlers.js','electron/preload.js','electron/main.js','electron/feishu-sync.js','frontend/assets/manager-DBuMfWSZ.js','frontend/assets/manager-CHCGsmDK.css','frontend/assets/index-CXzEw6Jt.js','frontend/assets/GuideSpotlight-Bc_qirTp.js']
for(const file of files)assert.deepEqual(asar.extractFile(archive,file.replaceAll('/',path.sep)),fs.readFileSync(file),file)
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,'0.2.29')
for(const entry of asar.listPackage(archive))assert.ok(!/(^|[\\/])(?:\.api_key|\.env(?:\.[^\\/]*)?|feishu\.env)$/.test(entry),'secret entry '+entry)
const manager=asar.extractFile(archive,'frontend/assets/manager-DBuMfWSZ.js'.replaceAll('/',path.sep)).toString()
for(const removed of ['id:"submissions"','submissions:$b','MySubmissionsPage','my-submissions','我的提交'])assert.ok(!manager.includes(removed),removed)
for(const page of ['library','stickers','templates','settings','exchange','about'])assert.ok(manager.includes('id:"'+page+'"'),page)
const handler=asar.extractFile(archive,'electron/handlers.js'.replaceAll('/',path.sep)).toString()
for(const command of ['get_feishu_config_status','import_feishu_config']){assert.ok(handler.includes(command));assert.ok(manager.includes(command))}
assert.ok(handler.includes('dialog.showOpenDialog'))
assert.ok(manager.includes('FeishuConfigCard'))
assert.ok(manager.includes('!R.value&&!g.busy.value'))
assert.ok(fs.readFileSync('README.md','utf8').includes('import-feishu-config.cmd'))
console.log('PASS: packaged sources and 0.2.29, removed page, retained pages, no env/key files, native settings import, media busy lock and README')
