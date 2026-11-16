'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

async function main() {
  const html = fs.readFileSync('frontend/manager.html', 'utf8')
  const bundle = fs.readFileSync('frontend/assets/manager-DBuMfWSZ.js', 'utf8')
  assert.ok(!html.includes('TemplatesPage-'), 'Templates JS/CSS must not load on manager startup')
  assert.ok(html.includes('rel="modulepreload" crossorigin="" href="/assets/GuideSpotlight-Bc_qirTp.js"'))
  assert.ok(html.includes('rel="stylesheet" crossorigin="" href="/assets/GuideSpotlight-rdxSa6cM.css"'))
  assert.ok(bundle.includes('import("./TemplatesPage-BlVodupk.js"),__vite__mapDeps([0,1,2,3])'))
  const added = []
  const existing = new Set(['/assets/GuideSpotlight-Bc_qirTp.js', '/assets/GuideSpotlight-rdxSa6cM.css'])
  const ctx = {
    document: {
      getElementsByTagName: () => [],
      querySelector: selector => {
        const href = selector.match(/href="([^"]+)"/)
        return href && existing.has(href[1]) ? {} : null
      },
      createElement: () => ({ listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn } }),
      head: { appendChild: element => added.push(element) },
    },
    window: { dispatchEvent() {} },
    Event: class {},
  }
  // Exercise the shipped Vite loader: Templates import must wait for its CSS.
  const start = bundle.indexOf('const mr="modulepreload"')
  const end = bundle.indexOf(',gr=[', start)
  assert.ok(start > 0 && end > start)
  vm.runInNewContext(bundle.slice(0, bundle.indexOf('\n')) +
    bundle.slice(start, end) + ';globalThis.load=br;globalThis.deps=__vite__mapDeps', ctx)
  assert.equal(added.length, 0)
  let imported = false
  const pending = ctx.load(async () => { imported = true; return 'Templates' }, ctx.deps([0, 1, 2, 3]))
  assert.equal(added.length, 2, 'shared GuideSpotlight assets stay loaded without duplicates')
  assert.ok(added.some(link => link.href === '/assets/TemplatesPage-BlVodupk.js' && link.rel === 'modulepreload'))
  const css = added.find(link => link.href === '/assets/TemplatesPage-CYL9cg58.css')
  assert.equal(css.rel, 'stylesheet')
  await Promise.resolve()
  assert.equal(imported, false, 'Templates render cannot race ahead of its stylesheet')
  css.listeners.load()
  assert.equal(await pending, 'Templates')
  assert.equal(imported, true)
  console.log('unit-manager-lazy: ok (shared preload retained, Templates deferred, CSS awaited)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
