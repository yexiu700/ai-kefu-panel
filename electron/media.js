'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const store = require('./store')

function failure(error) {
  if (error.code === 'ENOENT') return '文件不存在，请重新选择'
  if (error.code === 'EACCES' || error.code === 'EPERM') return '没有文件读写权限，请检查文件和数据目录权限'
  if (error.code === 'ENOSPC') return '磁盘空间不足，请清理后重试'
  if (error.code === 'EISDIR') return '请选择文件，不能添加文件夹'
  return error.mediaReason || '无法读取或保存文件，请检查文件是否可用及数据目录权限'
}
function invalid(message) { const e = new Error(message); e.mediaReason = message; throw e }
function imageExtension(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii',0,6))) return '.gif'
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return '.webp'
  if (bytes.toString('ascii',0,2) === 'BM') return '.bmp'
  invalid('图片格式不支持，请选择 PNG、JPEG、GIF、WebP 或 BMP 图片')
}
function saveBytes(input, { image = false, fileName = '' } = {}) {
  try {
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer) && !Array.isArray(input)) invalid('未收到文件内容，请重新添加')
    const bytes = Buffer.from(input)
    if (!bytes.length) invalid('文件内容为空，无法添加')
    const ext = image ? imageExtension(bytes) : ''
    const original = path.win32.basename(String(fileName)).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(-180)
    if (!image && (!original || original === '.' || original === '..')) invalid('附件文件名无效，请重新选择')
    const name = `${randomUUID()}-${image ? 'image' + ext : original}`
    fs.writeFileSync(path.join(store.mediaDir(), name), bytes, { flag: 'wx' })
    return name
  } catch (error) { throw new Error(failure(error)) }
}
function pickPaths(paths, image) {
  // Frontend pickers consume this contract, including cancellations and partial failures.
  const result = { names: [], errors: [], fileNames: [] }
  for (const src of paths) {
    try {
      const name = saveBytes(fs.readFileSync(src), { image, fileName: path.basename(src) })
      result.names.push(name)
      result.fileNames.push(path.basename(src))
    } catch (error) {
      result.errors.push(`无法添加「${path.basename(src)}」：${failure(error) === '无法读取或保存文件，请检查文件是否可用及数据目录权限' ? error.message : failure(error)}`)
    }
  }
  return result
}
function preparePhraseMedia(phrase) {
  const paths = [], errors = []
  let root
  try { root = fs.realpathSync(store.mediaDir()) }
  catch (e) { return { paths, errors: [failure(e)] } }
  const entries = [...(phrase.images || []).map(name => [name, true]), ...(phrase.files || []).map(name => [name, false])]
  for (const [name, image] of entries) {
    try {
      if (typeof name !== 'string' || !name || path.basename(name) !== name || /[\\/:]/.test(name)) invalid('媒体文件名无效，请重新添加')
      const file = fs.realpathSync(path.join(root, name))
      if (path.dirname(file).toLowerCase() !== root.toLowerCase()) invalid('媒体文件不在本地媒体目录，请重新添加')
      if (!fs.statSync(file).isFile()) invalid('媒体不是文件，请重新添加')
      fs.accessSync(file, fs.constants.R_OK)
      if (image) {
        const fd = fs.openSync(file, 'r')
        try { const header = Buffer.alloc(12); fs.readSync(fd, header, 0, 12, 0); imageExtension(header) }
        finally { fs.closeSync(fd) }
      }
      if (!paths.includes(file)) paths.push(file)
    } catch (e) { errors.push(`无法粘贴「${typeof name === 'string' ? path.basename(name) : '媒体'}」：${failure(e)}`) }
  }
  return { paths, errors }
}
module.exports = { saveBytes, pickPaths, preparePhraseMedia }
