// Run with Electron. Uses an isolated temporary library and real bundled renderer/preload/IPC.
const {app,BrowserWindow,ipcMain,dialog,protocol,net}=require('electron')
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict'),os=require('os')
const root=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'..')
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ai-media-ui-028-'))
app.setPath('userData',temp)
// Configuration status must also be isolated when visiting the settings tab.
os.homedir=()=>temp
protocol.registerSchemesAsPrivileged([{scheme:'huiyou-media',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}])
app.whenReady().then(async()=>{
 const store=require(path.join(root,'electron/store.js'))
 const {handleCommand}=require(path.join(root,'electron/handlers.js'))
 const image=fs.readFileSync(path.join(__dirname,'../docs/bugs/add-image-fail.jpg'))
 const input=path.join(temp,'sample.jpg');fs.writeFileSync(input,image)
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:[input]})
 store.saveLibrary({version:1,groups:[{id:'test',name:'测试分组',scope:'private',phrases:[]}],stickers:[]},{skipBackup:true})
 ipcMain.handle('tauri-invoke',async(_e,p)=>{if(['import_image','import_file'].includes(p.cmd))await new Promise(r=>setTimeout(r,700));return handleCommand(p.cmd,p.args,{})})
 protocol.handle('huiyou-media',req=>{const n=new URL(req.url).searchParams.get('p');return net.fetch(require('url').pathToFileURL(path.isAbsolute(n)?n:path.join(store.mediaDir(),n)).href)})
 const server=http.createServer((req,res)=>{const file=path.join(root,'frontend',new URL(req.url,'http://localhost').pathname);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file))}).listen(0,'127.0.0.1')
 await new Promise(r=>server.once('listening',r))
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{preload:path.join(root,'electron/preload.js'),sandbox:false,additionalArguments:['--window-label=manager']}})
 win.webContents.on('console-message',(_e,level,msg)=>{if(level>=3)console.error(msg)})
 await win.loadURL(`http://127.0.0.1:${server.address().port}/manager.html?tab=submissions`)
 const run=code=>win.webContents.executeJavaScript(code)
 const wait=async selector=>{for(let n=0;n<100;n++){if(await run(`!!document.querySelector(${JSON.stringify(selector)})`))return;await new Promise(r=>setTimeout(r,100))}throw Error('missing '+selector+' '+await run('document.body.innerText'))}
 await wait('[data-testid="nav-library"]')
 assert.equal(await run('!!document.querySelector("[data-testid=nav-submissions]")'),false)
 await run(`document.querySelector('[data-testid="manager-scope-tab"][data-scope="private"]').click()`)
 await wait('[data-testid="add-phrase"]');await run(`document.querySelector('[data-testid="add-phrase"]').click()`)
 await wait('[data-testid="phrase-editor-body"]')
 console.log(await run(`JSON.stringify([...document.querySelectorAll('[data-testid]')].filter(e=>/image|file|editor|save/.test(e.dataset.testid)).map(e=>[e.tagName,e.dataset.testid]))`))
 fs.writeFileSync(path.join(temp,'ui-inventory.txt'),await run('document.body.innerText'))
 global.testUI={win,run,wait,store,server,image,temp}
 await exercise(global.testUI)
 win.destroy();server.close();app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
async function exercise({win,run,wait,store,server,image,temp}) {
 const click=async id=>run('document.querySelector('+JSON.stringify('[data-testid="'+id+'"]').replace(/'/g,"\'")+').click()')
 const count=async n=>{for(let t=0;t<100;t++){if(await run(`document.querySelectorAll('[data-testid="image-thumb"]').length`)===n)return;await new Promise(r=>setTimeout(r,50))}throw Error('image count expected '+n+' '+await run('document.body.innerText'))}
 await click('add-images');await count(1)
 const b64=image.toString('base64')
 const dispatch=async(type,n=1)=>run(`(()=>{const dt=new DataTransfer();for(let i=0;i<${n};i++){const bytes=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));dt.items.add(new File([bytes],'sample.jpg',{type:'image/jpeg'}))}const el=document.querySelector('[data-testid="'+(${JSON.stringify(type)}==='paste'?'phrase-content-input':'phrase-editor-body')+'"]');el.dispatchEvent(${JSON.stringify(type)}==='paste'?new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))})()`)
 await run(`(()=>{const e=document.querySelector('[data-testid="phrase-content-input"]');e.value='race';e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 await dispatch('drop');await new Promise(r=>setTimeout(r,80))
 assert.equal(await run(`document.querySelector('[data-testid="phrase-save"]').disabled`),true,'save must be disabled during import')
 await click('phrase-save');await click('phrase-cancel')
 assert.equal(await run(`!!document.querySelector('[data-testid="phrase-editor-body"]')`),true,'close must wait for import')
 assert.equal(store.loadLibrary().groups.flatMap(g=>g.phrases).length,0)
 await count(2)
 await dispatch('paste');await count(3)
 await click('add-files');await wait('[data-testid="attachment"]')
 // Ordinary attachment drop/paste must share the same save/close lock.
 for(const type of ['drop','paste']) {
  await run(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['attachment content'],'中文附件.txt',{type:'text/plain'}));const el=document.querySelector('[data-testid="'+(${JSON.stringify(type)}==='paste'?'phrase-content-input':'phrase-editor-body')+'"]');el.dispatchEvent(${JSON.stringify(type)}==='paste'?new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))})()`)
  await new Promise(r=>setTimeout(r,80))
  assert.equal(await run(`document.querySelector('[data-testid="phrase-save"]').disabled`),true,'attachment import must disable save')
  await run(`document.querySelector('[data-testid="phrase-editor-body"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))`)
  await click('phrase-cancel')
  assert.equal(store.loadLibrary().groups.flatMap(g=>g.phrases).length,0)
  for(let n=0;n<100;n++){if(await run(`document.querySelectorAll('[data-testid="attachment"]').length`)=== (type==='drop'?2:3))break;if(n===99)throw Error('attachment import timeout');await new Promise(r=>setTimeout(r,50))}
 }

 await dispatch('drop',10);await count(9)
 await dispatch('paste');await count(9)
 assert.equal(await run(`document.querySelectorAll('[data-testid="image-thumb"] img').length`),9)
 for(let n=0;n<100;n++){if(await run(`[...document.querySelectorAll('[data-testid="image-thumb"] img')].every(e=>e.complete&&e.naturalWidth>0)`))break;if(n===99)throw Error('image preview not rendered');await new Promise(r=>setTimeout(r,50))}
 await click('phrase-save')
 for(let n=0;n<100;n++){if(store.loadLibrary().groups.some(g=>g.phrases.length))break;await new Promise(r=>setTimeout(r,50))}
 const phrase=store.loadLibrary().groups.flatMap(g=>g.phrases)[0];assert.equal(phrase.images.length,9);assert.equal(phrase.files.length,3)
 for(const tab of ['stickers','templates','settings','exchange','about','library']){await click('nav-'+tab);await new Promise(r=>setTimeout(r,150));assert.equal(await run(`document.querySelector('[data-testid="nav-${tab}"]').getAttribute("data-active")`),'true')}
 console.log('PASS: real renderer click/drop/paste, 9 image limit, decoded previews, attachment drop/paste + race locks, save, removed route, retained pages',temp)
}

