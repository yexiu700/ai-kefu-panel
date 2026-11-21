'use strict'

// 共享的话术搜索、拼音索引、高亮与安全转义工具（浏览器 <script> 与 Node 单测共用）。
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const safeHexColor = (c) => {
  const s = String(c ?? '').trim()
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : ''
}

const tokensOf = (q) => String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)

function createSearchEngine({ getPinyin = () => null } = {}) {
  const pyCache = new Map()

  function pyInfo(text) {
    let info = pyCache.get(text)
    if (info) return info
    const low = text.toLowerCase()
    info = { low, py: '', pyMap: [], pyStart: [], ini: '', iniMap: [], hasZh: false }
    const PY = getPinyin()
    if (PY && /[㐀-鿿]/.test(text)) {
      info.hasZh = true
      let pos = 0
      let py = ''
      let ini = ''
      for (const it of PY.pinyin(text, { type: 'all', toneType: 'none', v: true })) {
        const o = String(it.origin ?? '')
        const len = o.length || 1
        const s = it.isZh ? String(it.pinyin || '').toLowerCase() : o.toLowerCase()
        const f = it.isZh ? (s[0] || '') : o.toLowerCase()
        for (let k = 0; k < s.length; k++) { info.pyMap.push([pos, pos + len]); info.pyStart.push(k === 0) }
        for (let k = 0; k < f.length; k++) info.iniMap.push([pos, pos + len])
        py += s
        ini += f
        pos += len
      }
      info.py = py
      info.ini = ini
    }
    if (pyCache.size > 8000) pyCache.clear()
    pyCache.set(text, info)
    return info
  }

  // 返回 token 在原文中的命中区间（原文下标），kind: 0 原文 / 1 全拼 / 2 首字母；未命中返回 null
  function findToken(text, t) {
    const info = pyInfo(text)
    const ranges = []
    let i = info.low.indexOf(t)
    while (i !== -1) { ranges.push([i, i + t.length]); i = info.low.indexOf(t, i + t.length) }
    if (ranges.length) return { kind: 0, ranges }
    if (!info.hasZh || !/^[a-z0-9]+$/.test(t)) return null
    // 全拼：须从某个字的拼音开头起匹配（末尾允许只打了一半，如 niha）
    i = info.py.indexOf(t)
    while (i !== -1) {
      if (info.pyStart[i]) ranges.push([info.pyMap[i][0], info.pyMap[i + t.length - 1][1]])
      i = info.py.indexOf(t, i + 1)
    }
    if (ranges.length) return { kind: 1, ranges }
    i = info.ini.indexOf(t)
    while (i !== -1) {
      ranges.push([info.iniMap[i][0], info.iniMap[i + t.length - 1][1]])
      i = info.ini.indexOf(t, i + t.length)
    }
    return ranges.length ? { kind: 2, ranges } : null
  }

  function highlight(text, tokens) {
    const raw = String(text ?? '')
    if (!tokens.length) return esc(raw)
    const ranges = []
    for (const t of tokens) { const m = findToken(raw, t); if (m) ranges.push(...m.ranges) }
    if (!ranges.length) return esc(raw)
    ranges.sort((a, b) => a[0] - b[0])
    const merged = [ranges[0].slice()]
    for (const r of ranges.slice(1)) {
      const last = merged[merged.length - 1]
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice())
    }
    let out = ''
    let pos = 0
    for (const [a, b] of merged) { out += esc(raw.slice(pos, a)) + '<mark>' + esc(raw.slice(a, b)) + '</mark>'; pos = b }
    return out + esc(raw.slice(pos))
  }

  // 命中位置靠后时截取片段，保证两行内能看到高亮
  function snippet(text, tokens) {
    const s = String(text ?? '')
    if (!tokens.length) return s
    let first = -1
    for (const t of tokens) {
      const m = findToken(s, t)
      const i = m ? m.ranges[0][0] : -1
      if (i !== -1 && (first === -1 || i < first)) first = i
    }
    return first > 36 ? '…' + s.slice(first - 14) : s
  }

  // 仅搜索标题（不搜正文），按命中位置与类型打分，附加轻量使用频次加权
  function scoreFor(p, tokens, usage = {}) {
    if (!tokens.length) return 1
    const title = String(p.title || '')
    let score = 0
    for (const t of tokens) {
      const mt = title ? findToken(title, t) : null
      if (mt) {
        const atStart = mt.ranges[0][0] === 0
        score += mt.kind === 0 ? (atStart ? 6 : 4) : (atStart ? 5 : 3)
      } else return 0
    }
    const u = usage?.[p.id]
    return score + (u ? Math.min(u.n, 20) * 0.05 : 0)
  }

  return {
    pyInfo,
    findToken,
    highlight,
    snippet,
    scoreFor,
    clearCache: () => pyCache.clear(),
    cacheSize: () => pyCache.size,
  }
}

const searchApi = { esc, safeHexColor, tokensOf, createSearchEngine }
if (typeof module !== 'undefined' && module.exports) module.exports = searchApi
if (typeof window !== 'undefined') window.PanelSearch = searchApi
