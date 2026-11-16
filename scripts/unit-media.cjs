'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm')
const { createRequire } = require('node:module')
function load(file, mocks) {
 const filename=path.resolve(file), real=createRequire(filename)
 const sandbox={module:{exports:{}},require:id=>id in mocks?mocks[id]:real(id),console,process,Buffer,Uint8Array,ArrayBuffer,structuredClone}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),sandbox,{filename});return sandbox.module.exports
}
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-media-028-'))
 let selection={canceled:false,filePaths:[path.resolve('docs/bugs/add-image-fail.jpg')]}
 const electron={app:{getPath:()=>dir},BrowserWindow:{getFocusedWindow:()=>null},dialog:{showOpenDialog:async()=>selection},nativeImage:require('electron').nativeImage}
 const store=load('electron/store.js',{electron})
 const media=load('electron/media.js',{'./store':store})
 const handlers=load('electron/handlers.js',{electron,'./store':store,'./media':media,'./send':{},'./send-log':{},'./win32':{},'./assist':{},'./feishu-sync':{}})
 const pick=await handlers.handleCommand('pick_images')
 // This is the exact iteration performed by the shipped phrase editor.
 assert.doesNotThrow(()=>{for(const error of pick.errors)assert.equal(typeof error,'string')},'图片选择应返回可遍历 errors')
 assert.equal(pick.names.length,1)
 assert.ok(fs.existsSync(path.join(store.mediaDir(),pick.names[0])))
 const jpg=fs.readFileSync(selection.filePaths[0])
 const imported=await handlers.handleCommand('import_image',{bytes:new Uint8Array(jpg)})
 assert.equal(typeof imported,'string');assert.deepEqual(fs.readFileSync(path.join(store.mediaDir(),imported)),jpg)
 const file=await handlers.handleCommand('import_file',{bytes:new Uint8Array([1,2,3]),fileName:'说明.txt'})
 assert.ok(file.endsWith('-说明.txt'))
 assert.deepEqual(fs.readFileSync(path.join(store.mediaDir(),file)),Buffer.from([1,2,3]))
 const pickedFile=await handlers.handleCommand('pick_files');assert.equal(pickedFile.names.length,1);assert.equal(pickedFile.errors.length,0)
 selection={canceled:true,filePaths:[]};const cancel=await handlers.handleCommand('pick_images');assert.equal(cancel.names.length,0);assert.equal(cancel.errors.length,0)
 selection={canceled:false,filePaths:[path.join(dir,'missing.png'),path.resolve('docs/bugs/add-image-fail.jpg')]}
 const partial=await handlers.handleCommand('pick_images');assert.equal(partial.names.length,1);assert.match(partial.errors[0],/不存在/)
 await assert.rejects(handlers.handleCommand('import_image',{bytes:new Uint8Array([1,2,3])}),/图片/)
 await assert.rejects(handlers.handleCommand('import_file',{bytes:new Uint8Array(),fileName:'empty.txt'}),/空/)
 const prepared = media.preparePhraseMedia({images:[pick.names[0]],files:[pickedFile.names[0],'missing.pdf','../outside.txt']})
 assert.equal(prepared.paths.length,2)
 assert.equal(prepared.errors.length,2)
 assert.match(prepared.errors[0],/不存在/)
 assert.match(prepared.errors[1],/无效/)
 const bad = media.saveBytes(new Uint8Array([1,2,3]),{fileName:'invalid.png'})
 assert.match(media.preparePhraseMedia({images:[bad]}).errors[0],/图片格式不支持/)
 const deniedMedia=load('electron/media.js',{'./store':store,'node:fs':{...fs,accessSync:()=>{const e=new Error('denied');e.code='EACCES';throw e}}})
 assert.match(deniedMedia.preparePhraseMedia({images:[pick.names[0]]}).errors[0],/权限/)
 let sent
 electron.BrowserWindow.getAllWindows=()=>[]
 const senderHandlers=load('electron/handlers.js',{electron,'./store':{...store,loadLibrary:()=>({groups:[{phrases:[{id:'media-test',content:'hello',images:pick.names,files:pickedFile.names}]}]}),loadSettings:()=>({send:{}})},'./media':media,'./send':{sendPhrase:async(p,o)=>{sent={p,o};return {ok:true,hasMedia:true}}},'./send-log':{},'./win32':{},'./assist':{},'./feishu-sync':{}})
 await senderHandlers.handleCommand('send_phrase',{phraseId:'media-test',mode:'fill'})
 assert.equal(sent.p.images[0],pick.names[0])
 assert.equal(sent.p.files[0],pickedFile.names[0])
 assert.equal(sent.o.mode,'fill')
 console.log('PASS: actual IPC pick/import image + attachment, bytes persisted, cancellation, partial errors, invalid content')
}
main().catch(e=>{console.error(e);process.exitCode=1})
