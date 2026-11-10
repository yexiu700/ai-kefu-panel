'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const ACCENT = '#b84b2d'
const WIN_CHAT_APPS = [
  'weixin.exe', 'wechat.exe', 'wxwork.exe', 'qq.exe', 'tim.exe',
  // 国内电商客服工作台
  'aliworkbench.exe', // 千牛
  'pddworkbench.exe', 'pddwebworkbench.exe', // 拼多多商家平台
  'jmworkstation.exe', 'jm_dd_workbench.exe', 'jdm_dd_workbench.exe', 'pop_dd_workbench.exe', 'JingMai.exe', // 京麦 / 咚咚
  '紫鸟', '紫鸟.exe', '紫鸟浏览器', '紫鸟浏览器.exe', // 紫鸟浏览器
  'doudian.exe', // 抖店
  'dewu.exe', 'dewumerchant.exe', '得物.exe', '得物商家客服.exe', // 得物
  '千帆客服工作台.exe', // 小红书千帆客服工作台
  '微信小店助手.exe', 'weixinstore.exe', 'WeixinStore.exe', // 微信小店
  'dingtalk.exe', 'feishu.exe',
  'lark.exe', 'telegram.exe', 'whatsapp.exe', 'slack.exe', 'discord.exe',
  // demo: also follow Grok Bot / Cursor / common browsers when used as chat surface
  'Grok Bot.exe', 'grok.exe', 'Cursor.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe',
]
const MAC_CHAT_APPS = [
  'wechat', '企业微信', 'qq', 'dingtalk', 'feishu', 'lark',
  'telegram', 'whatsapp', 'slack', 'discord',
]

function defaultSettings() {
  const isMac = process.platform === 'darwin'
  return {
    feishuAppId: '',
    feishuAppSecret: '',
    feishuBaseToken: 'E6cZbMS57aJWyis3SV3c7cFInKh',
    feishuTableId: 'tblBEtFX7gsg8CKX',
    feishuLibraryRegion: 'domestic',
    feishuSyncOnLaunch: false,
    feishuLastSyncAt: null,
    feishuLastSyncMessage: '',
    theme: 'auto',
    accent: ACCENT,
    send: {
      mode: 'send',
      key: 'enter',
      intervalMs: 400,
      pasteDelayMs: 80,
      restoreClipboard: true,
      appRules: [],
    },
    panel: {
      docked: false,
      side: 'right',
      width: 300,
      floatX: null,
      floatY: null,
      floatWidth: 320,
      floatHeight: 832,
      alwaysOnTop: true,
      autoBind: true,
      chatApps: isMac ? [...MAC_CHAT_APPS] : [...WIN_CHAT_APPS],
      showPreview: true,
      hoverPreview: true,
    },
    hotkeys: {
      togglePanel: 'Ctrl+Alt+K',
      focusSearch: 'Ctrl+Alt+F',
      assist: 'Ctrl+Alt+J',
    },
  }
}

function emptyLibrary() {
  return normalizeLibrary({ version: 1, groups: [], stickers: [] })
}

function normalizePhrase(p = {}) {
  return {
    id: p.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: p.title ?? '',
    content: p.content ?? '',
    titleColor: p.titleColor ?? null,
    images: Array.isArray(p.images) ? p.images : [],
    files: Array.isArray(p.files) ? p.files : [],
    hotkey: p.hotkey ?? null,
    favorite: p.favorite === true,
    section: p.section ?? p.sectionId ?? null,
    useCount: Number.isFinite(p.useCount) && p.useCount > 0 ? Math.floor(p.useCount) : 0,
    lastUsedAt: Number.isFinite(p.lastUsedAt) ? p.lastUsedAt : null,
    createdAt: p.createdAt ?? Date.now(),
    updatedAt: p.updatedAt ?? Date.now(),
  }
}

function normalizeGroup(g = {}) {
  return {
    id: g.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: g.name ?? '未命名分组',
    color: g.color ?? null,
    scope: (g.scope === 'team' ? 'company' : (g.scope || 'company')),
    apps: Array.isArray(g.apps) ? g.apps : [],
    sections: Array.isArray(g.sections) ? g.sections.map((s) => ({
      id: s.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: s.name ?? '',
    })) : [],
    phrases: Array.isArray(g.phrases) ? g.phrases.map(normalizePhrase) : [],
    squad: null,
  }
}

function normalizeLibrary(raw) {
  const lib = raw && typeof raw === 'object' ? raw : {}
  return {
    version: lib.version || 1,
    groups: Array.isArray(lib.groups) ? lib.groups.map(normalizeGroup) : [],
    stickers: Array.isArray(lib.stickers) ? lib.stickers : [],
    stickerNames: lib.stickerNames && typeof lib.stickerNames === 'object' ? lib.stickerNames : {},
  }
}


function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(patch)) return patch.slice()
  if (typeof patch !== 'object') return patch
  const out = { ...(typeof base === 'object' && base && !Array.isArray(base) ? base : {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = deepMerge(out[k], v)
  }
  return out
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'huiyou-original-shell')
  ensureDir(dir)
  ensureDir(path.join(dir, 'backups'))
  ensureDir(path.join(dir, 'media'))
  ensureDir(path.join(dir, 'stickers'))
  return dir
}

function libraryPath() {
  return path.join(getDataDir(), 'library.json')
}

function settingsPath() {
  return path.join(getDataDir(), 'settings.json')
}

function loadLibrary() {
  const p = libraryPath()
  if (!fs.existsSync(p)) {
    const lib = emptyLibrary()
    saveLibrary(lib, { skipBackup: true })
    return lib
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return normalizeLibrary(raw)
  } catch (e) {
    console.warn('[store] library corrupt, reset', e)
    const lib = emptyLibrary()
    saveLibrary(lib, { skipBackup: true })
    return lib
  }
}

function saveLibrary(library, opts = {}) {
  const p = libraryPath()
  library = normalizeLibrary(library)
  if (!opts.skipBackup && fs.existsSync(p)) backupNow()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(library, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

function normalizeSettings(raw) {
  const defaults = defaultSettings()
  const merged = deepMerge(defaults, raw && typeof raw === 'object' ? raw : {})
  if (!Array.isArray(merged.panel.chatApps)) merged.panel.chatApps = []
  // keep user list, but always include new default chat apps (e.g. Grok Bot)
  const seen = new Set(merged.panel.chatApps.map((x) => String(x).toLowerCase()))
  for (const app of defaults.panel.chatApps) {
    const key = String(app).toLowerCase()
    if (!seen.has(key)) {
      merged.panel.chatApps.push(app)
      seen.add(key)
    }
  }
  if (!Array.isArray(merged.send.appRules)) merged.send.appRules = []
  if (!merged.hotkeys || typeof merged.hotkeys !== 'object') {
    merged.hotkeys = defaults.hotkeys
  }
  // 默认不吸附；仅用户明确改过 docked 才保留
  if (!merged.panel.dockedTouched) {
    merged.panel.docked = false
  }
  // 窗口高度默认拉长约 30%（640 → 832）；未手动改过时升级
  if (!merged.panel.heightTouched) {
    const h = Number(merged.panel.floatHeight) || 0
    if (h <= 640) merged.panel.floatHeight = 832
  }
  if (!merged.hotkeys || typeof merged.hotkeys !== 'object') merged.hotkeys = { ...defaults.hotkeys }
  if (!merged.hotkeys.assist) merged.hotkeys.assist = defaults.hotkeys.assist
  if (!merged.hotkeys.togglePanel) merged.hotkeys.togglePanel = defaults.hotkeys.togglePanel
  if (!merged.hotkeys.focusSearch) merged.hotkeys.focusSearch = defaults.hotkeys.focusSearch
  return merged
}

function loadSettings() {
  const defaults = defaultSettings()
  const p = settingsPath()
  if (!fs.existsSync(p)) {
    saveSettings(defaults)
    return structuredClone(defaults)
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    const next = normalizeSettings(raw)
    // 用户没 touch 过吸附开关时，强制落成不吸附并写回
    if (!raw?.panel?.dockedTouched && (raw?.panel?.docked === true || next.panel.docked !== false)) {
      next.panel.docked = false
      saveSettings(next)
    }
    return next
  } catch {
    return structuredClone(defaults)
  }
}

function saveSettings(settings) {
  const p = settingsPath()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

function updateSettings(patch) {
  patch = patch || {}
  if (patch.panel && Object.prototype.hasOwnProperty.call(patch.panel, 'docked')) {
    patch = deepMerge(patch, { panel: { dockedTouched: true } })
  }
  if (patch.panel && Object.prototype.hasOwnProperty.call(patch.panel, 'floatHeight')) {
    patch = deepMerge(patch, { panel: { heightTouched: true } })
  }
  const next = normalizeSettings(deepMerge(loadSettings(), patch))
  saveSettings(next)
  return next
}

function pruneBackups(keep = 20) {
  const dir = path.join(getDataDir(), 'backups')
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  for (const extra of files.slice(Math.max(1, keep))) {
    try { fs.unlinkSync(path.join(dir, extra.f)) } catch { /* ignore */ }
  }
}

function backupNow(keep = 20) {
  const dir = path.join(getDataDir(), 'backups')
  ensureDir(dir)
  const src = libraryPath()
  const createdAt = new Date().toISOString()
  const stamp = createdAt.replace(/[:.]/g, '-')
  const fileName = `library-${stamp}.json`
  const dest = path.join(dir, fileName)
  if (fs.existsSync(src)) fs.copyFileSync(src, dest)
  else fs.writeFileSync(dest, JSON.stringify(emptyLibrary(), null, 2))
  const stat = fs.statSync(dest)
  pruneBackups(keep)
  return { id: fileName, fileName, createdAt, size: stat.size }
}

function listBackups() {
  const dir = path.join(getDataDir(), 'backups')
  ensureDir(dir)
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f))
      return { id: f, fileName: f, createdAt: st.mtime.toISOString(), size: st.size }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

function restoreBackup(id) {
  const safe = path.basename(id)
  const p = path.join(getDataDir(), 'backups', safe)
  if (!fs.existsSync(p)) throw new Error('备份不存在')
  const lib = JSON.parse(fs.readFileSync(p, 'utf8'))
  saveLibrary(lib, { skipBackup: false })
  return loadLibrary()
}

function mediaDir() { return path.join(getDataDir(), 'media') }
function stickersDir() { return path.join(getDataDir(), 'stickers') }

function copyIntoMedia(src, sub = 'media') {
  const dir = sub === 'stickers' ? stickersDir() : mediaDir()
  ensureDir(dir)
  const base = path.basename(src)
  const dest = path.join(dir, `${Date.now()}-${base}`)
  fs.copyFileSync(src, dest)
  return dest
}

function getStats(library) {
  const lib = library || loadLibrary()
  let phrases = 0
  for (const g of lib.groups || []) phrases += (g.phrases || []).length
  return {
    groups: (lib.groups || []).length,
    phrases,
    stickers: (lib.stickers || []).length,
    size: fs.existsSync(libraryPath()) ? fs.statSync(libraryPath()).size : 0,
  }
}

module.exports = {
  normalizeLibrary,
  normalizeSettings,
  defaultSettings,
  emptyLibrary,
  deepMerge,
  getDataDir,
  loadLibrary,
  saveLibrary,
  loadSettings,
  saveSettings,
  updateSettings,
  backupNow,
  listBackups,
  restoreBackup,
  mediaDir,
  stickersDir,
  copyIntoMedia,
  getStats,
  libraryPath,
}
