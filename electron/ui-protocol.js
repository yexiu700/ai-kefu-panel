'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json',
}

function resolveUiPath(root, rawUrl) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'aikefu:' || url.host !== 'ui' || url.username || url.password) {
    throw new Error('Invalid UI origin')
  }
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  // Reject Windows separators, drive/ADS syntax and encoded traversal before joining.
  if (/[\\:\0]/.test(pathname) || pathname.split('/').includes('..')) {
    throw new Error('Invalid UI path')
  }
  const file = path.resolve(root, '.' + pathname)
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('UI path outside frontend')
  }
  return file
}

function createUiHandler(root, fetchFile) {
  return async (request) => {
    let file
    try { file = resolveUiPath(root, request.url) }
    catch { return new Response('forbidden', { status: 403 }) }
    if (request.method && !['GET', 'HEAD'].includes(request.method)) {
      return new Response('method not allowed', { status: 405 })
    }
    try {
      if (!fs.statSync(file).isFile()) return new Response('not found', { status: 404 })
      const response = await fetchFile(pathToFileURL(file).href)
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
      })
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new Response('not found', { status: 404 })
      console.warn('[ui protocol]', error)
      return new Response('UI resource unavailable', { status: 500 })
    }
  }
}

module.exports = { resolveUiPath, createUiHandler }
