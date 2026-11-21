'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { resolveUiPath, createUiHandler } = require('../electron/ui-protocol')
const root = path.resolve('frontend')

async function main() {
  for (const asset of ['index.html', 'manager.html', 'panel/panel.js', 'panel/send-rule.js', 'panel/vendor/pinyin-pro.js',
    'brand-theme.css', 'assets/TemplatesPage-BlVodupk.js', 'assets/TemplatesPage-CYL9cg58.css']) {
    assert.equal(resolveUiPath(root, `aikefu://ui/${asset}?label=panel`), path.join(root, asset))
    assert.ok(fs.statSync(path.join(root, asset)).isFile(), asset)
  }
  assert.equal(resolveUiPath(root, 'aikefu://ui/'), path.join(root, 'index.html'))
  assert.equal(new URL('./TemplatesPage-BlVodupk.js', 'aikefu://ui/assets/manager-DBuMfWSZ.js').href,
    'aikefu://ui/assets/TemplatesPage-BlVodupk.js')
  assert.equal(new URL('/panel/panel.js', 'aikefu://ui/index.html').href, 'aikefu://ui/panel/panel.js')
  for (const url of ['https://ui/index.html', 'aikefu://other/index.html',
    'aikefu://ui:123/index.html', 'aikefu://name@ui/index.html',
    'aikefu://ui/%2e%2e%2fpackage.json', 'aikefu://ui/..%5cpackage.json',
    'aikefu://ui/C%3a/file', 'aikefu://ui/file%00.js', 'aikefu://ui/%ZZ']) {
    assert.throws(() => resolveUiPath(root, url), url)
  }
  // Exercise the real handler with a file-fetch substitute: no Electron/userData needed.
  const handler = createUiHandler(root, async url => new Response(fs.readFileSync(fileURLToPath(url))))
  for (const [asset, mime] of [['index.html', 'text/html'], ['panel/panel.js', 'text/javascript'],
    ['panel/send-rule.js', 'text/javascript'],
    ['assets/TemplatesPage-BlVodupk.js', 'text/javascript'], ['brand-theme.css', 'text/css'],
    ['panel/default-company-library.json', 'application/json']]) {
    const response = await handler({ url: `aikefu://ui/${asset}?tab=templates`, method: 'GET' })
    assert.equal(response.status, 200, asset)
    assert.ok(response.headers.get('content-type').startsWith(mime))
    assert.ok((await response.arrayBuffer()).byteLength > 0)
  }
  assert.equal((await handler({ url: 'aikefu://ui/missing.js' })).status, 404)
  assert.equal((await handler({ url: 'aikefu://ui/panel/' })).status, 404)
  assert.equal((await handler({ url: 'aikefu://ui/..%5cpackage.json' })).status, 403)
  assert.equal((await handler({ url: 'aikefu://ui/index.html', method: 'POST' })).status, 405)
  assert.equal(await (await handler({ url: 'aikefu://ui/index.html', method: 'HEAD' })).text(), '')
  const htmlResp = await handler({ url: 'aikefu://ui/index.html', method: 'GET' })
  const csp = htmlResp.headers.get('content-security-policy') || ''
  assert.match(csp, /script-src 'self' aikefu:/, 'HTML response must carry script-src CSP')
  assert.match(csp, /img-src [^;]*aikefu-media:/, 'CSP must allow aikefu-media images')
  assert.match(csp, /object-src 'none'/, 'CSP must disallow plugins/objects')

  const main = fs.readFileSync('electron/main.js', 'utf8')
  assert.ok(main.indexOf('registerSchemesAsPrivileged') < main.indexOf('app.whenReady()'))
  assert.ok(main.includes("scheme: 'aikefu-media'"))
  assert.ok(main.includes('resolveMediaReadPath'), 'aikefu-media protocol must validate paths via media.resolveMediaReadPath')
  assert.ok(main.includes("protocol.handle('aikefu', createUiHandler(FRONTEND"))
  assert.ok(main.includes('aikefu://ui/${page}?label='))
  assert.ok(!main.includes('startStaticServer'))
  assert.ok(main.includes("app.requestSingleInstanceLock()"))
  assert.ok(main.includes("'ai-kefu-panel'"))

  const panel = fs.readFileSync('frontend/panel/panel.js', 'utf8')
  assert.ok(panel.includes('safeHexColor(g.color)'), 'panel.js must validate group color via safeHexColor before injecting inline style')
  console.log('unit-ui-protocol: PASS (paths, traversal, CSP, media boundary, g.color check, assets, MIME, fetch, registration)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
