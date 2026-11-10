'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')

const prefixes = ['HUIYOU_FEISHU_', 'AIKEFU_FEISHU_']
const names = ['APP_ID', 'APP_SECRET', 'DOMESTIC_BASE_TOKEN', 'DOMESTIC_TABLE_ID', 'OVERSEAS_BASE_TOKEN', 'OVERSEAS_TABLE_ID']
const defaultPath = () => path.join(os.homedir(), '.config', 'ai-kefu-panel', 'feishu.env')
const assignment = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/

// Never include source text or raw filesystem errors in an IPC response.
function publicError(error) {
  if (error.configMessage) return error.configMessage
  if (error.code === 'ENOENT') return '配置文件不存在，请重新选择。'
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return '无法读取或写入配置，请检查文件和目标目录权限。'
  if (error.code === 'ENOSPC') return '磁盘空间不足，原配置未被替换。'
  return '配置读取或写入失败，原配置未被替换。'
}
function invalid(message) { const error = new Error(message); error.configMessage = message; throw error }
function parse(text, strict = false) {
  const result = {}
  if (text.includes('\0') || text.includes('\uFFFD')) invalid('配置格式无效，请使用 UTF-8 文本文件，且不能含空字符。')
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const match = line.match(assignment)
    if (!match) { if (strict) invalid('配置格式无效，每行应为 KEY=值 或注释。'); continue }
    let value = match[2]
    if (/^['"]/.test(value)) {
      if (value.length < 2 || value.at(-1) !== value[0]) invalid('配置格式无效，值的引号未配对。')
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}
function importedValues(text) {
  const source = parse(text, true), values = {}
  for (const name of names) {
    for (const prefix of prefixes) {
      if (Object.hasOwn(source, prefix + name)) {
        const value = source[prefix + name]
        if (!value.trim() || /[\r\n\0]/.test(value)) invalid('配置项不能为空，且不能包含换行或空字符。')
        values[name] = value
        break
      }
    }
  }
  if (!values.APP_ID || !values.APP_SECRET) invalid('文件中缺少有效的飞书 App ID 或 App Secret。')
  return values
}
function merge(text, values) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const written = new Set()
  const output = lines.map(line => {
    const match = line.match(assignment)
    if (match) for (const name of names) {
      if (Object.hasOwn(values, name) && prefixes.some(prefix => prefix + name === match[1])) {
        written.add(match[1]); return match[1] + '=' + values[name]
      }
    }
    return line
  })
  for (const name of names) {
    const key = 'AIKEFU_FEISHU_' + name
    if (Object.hasOwn(values, name) && !written.has(key)) output.push(key + '=' + values[name])
  }
  return output.join('\n') + '\n'
}
function status(targetPath = defaultPath(), env = process.env) {
  const file = fs.existsSync(targetPath) ? parse(fs.readFileSync(targetPath, 'utf8')) : {}
  const read = name => env[prefixes[0] + name] ?? env[prefixes[1] + name] ?? file[prefixes[0] + name] ?? file[prefixes[1] + name] ?? ''
  const appId = read('APP_ID'), secretConfigured = !!read('APP_SECRET').trim()
  return { configured: !!appId.trim() && secretConfigured, appIdMasked: appId ? appId.slice(0, Math.min(4, Math.max(0, appId.length - 1))) + '…' : '', secretConfigured }
}
function importFile(sourcePath, targetPath = defaultPath(), env = process.env) {
  if (fs.statSync(sourcePath).size > 1024 * 1024) invalid('配置文件过大，请选择不超过 1 MB 的文本文件。')
  const values = importedValues(fs.readFileSync(sourcePath, 'utf8'))
  const previous = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : ''
  const content = merge(previous, values)
  parse(content) // Reject invalid retained content before replacing the original.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const tempPath = targetPath + '.' + randomUUID() + '.tmp'
  // Same-directory rename replaces only after the complete file has been flushed.
  // On failure the original remains intact. A temporary file may remain for recovery.
  const fd = fs.openSync(tempPath, 'wx', 0o600)
  try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tempPath, targetPath)
  // Refresh existing aliases only in this process; never change OS environment variables.
  for (const name of names) if (Object.hasOwn(values, name)) {
    for (const prefix of prefixes) if (Object.hasOwn(env, prefix + name)) env[prefix + name] = values[name]
  }
  return { ok: true, ...status(targetPath, env), message: '飞书配置已导入，当前进程可立即同步。App Secret：已配置。' }
}
module.exports = { defaultPath, status, importFile, publicError }
