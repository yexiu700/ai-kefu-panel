/* AI客服 · 主面板
 * 直接走 preload 注入的 __TAURI_INTERNALS__，命令/事件与原版后端一致，主进程无需改动。
 */
(() => {
  'use strict'

  const T = window.__TAURI_INTERNALS__
  const invoke = (cmd, args) => T.invoke(cmd, args || {})
  const listen = (event, cb) => invoke('plugin:event|listen', {
    event, target: { kind: 'Any' }, handler: T.transformCallback((e) => cb(e.payload)),
  })

  const $ = (s) => document.querySelector(s)
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* ignore */ } },
  }

  // ———————————————————— 状态 ————————————————————
  const S = {
    library: { groups: [] },
    settings: null,
    target: null,
    assist: { phase: 'idle' },
    scope: LS.get('aikefu.scope', 'company'),
    q: '',
    favOnly: LS.get('aikefu.favOnly', false),
    collapsed: new Set(LS.get('aikefu.collapsed', [])),
    fqCollapsed: LS.get('aikefu.collapse.frequent', false),
    usage: LS.get('aikefu.usage.v1', {}), // id -> { n, t }
    rows: [],        // 当前可见的话术（扁平，键盘导航用）
    active: -1,
    busyId: null,
    aiDraft: '',
    aiPick: 0,
    aiCollected: '', // 已收录的回复文本，防重复
  }

  // ———————————————————— 工具 ————————————————————
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const scopeOf = (g) => (g.scope === 'private' ? 'private' : 'company')
  const tokensOf = (q) => q.trim().toLowerCase().split(/\s+/).filter(Boolean)

  // ———— 拼音索引：全拼 / 首字母，按文本缓存，避免每次按键重算 ————
  // py/ini 为拼接后的串，pyMap/iniMap 记录串中每个位置对应原文的字符下标，用于把拼音命中映射回中文高亮
  const PY = window.pinyinPro
  const pyCache = new Map()
  function pyInfo(text) {
    let info = pyCache.get(text)
    if (info) return info
    const low = text.toLowerCase()
    info = { low, py: '', pyMap: [], pyStart: [], ini: '', iniMap: [], hasZh: false }
    if (PY && /[㐀-鿿]/.test(text)) {
      info.hasZh = true
      let pos = 0
      let py = ''; let ini = ''
      for (const it of PY.pinyin(text, { type: 'all', toneType: 'none', v: true })) {
        const o = String(it.origin ?? ''); const len = o.length || 1
        const s = it.isZh ? String(it.pinyin || '').toLowerCase() : o.toLowerCase()
        const f = it.isZh ? (s[0] || '') : o.toLowerCase()
        for (let k = 0; k < s.length; k++) { info.pyMap.push([pos, pos + len]); info.pyStart.push(k === 0) }
        for (let k = 0; k < f.length; k++) info.iniMap.push([pos, pos + len])
        py += s; ini += f; pos += len
      }
      info.py = py; info.ini = ini
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
    let out = ''; let pos = 0
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

  let toastTimer = 0
  function toast(msg, kind = '') {
    const el = $('#toast')
    el.textContent = msg
    el.className = 'toast' + (kind ? ' ' + kind : '')
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { el.hidden = true }, kind === 'err' ? 3600 : 2200)
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true } catch { /* fallthrough */ }
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
    return ok
  }

  // ———————————————————— 目标窗口 ————————————————————
  const hasTarget = () => !!(S.target && S.target.hwnd)
  const defaultMode = () => (S.settings?.send?.mode === 'fill' ? 'fill' : 'send')

  function renderTarget() {
    const dot = $('#targetDot'); const txt = $('#targetText')
    const t = S.target
    if (!hasTarget()) {
      dot.className = 'dot'
      txt.textContent = '未连接聊天窗 · 点话术仅复制'
    } else {
      const name = (t.title || t.exe || '聊天窗').trim()
      dot.className = 'dot ' + (t.bound ? 'lock' : 'follow')
      txt.textContent = (t.bound ? '已锁定 · ' : '跟随 · ') + name
    }
    $('#targetBtn').title = hasTarget()
      ? `${S.target.bound ? '已锁定' : '自动跟随前台聊天软件'}：${S.target.title || S.target.exe}\n点击管理`
      : '尚未检测到聊天窗：切到任一商家工作台（千牛/拼多多/抖店/京麦/快手/微信小店/网页版…）即可自动跟随，或点击手动选择'
  }

  // ———————————————————— 话术列表 ————————————————————
  function scoreFor(p, tokens) {
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
    const u = S.usage[p.id]
    return score + (u ? Math.min(u.n, 20) * 0.05 : 0)
  }

  function groupsInScope(scope) {
    const groups = (S.library.groups || []).filter((g) => scopeOf(g) === scope)
    // 分组若限定了适用软件，且与当前窗口匹配，则排到最前
    const exe = String(S.target?.exe || '').toLowerCase().replace(/\.exe$/, '')
    if (!exe) return groups
    const hit = (g) => (g.apps || []).some((a) => {
      const n = String(a?.exe ?? a?.name ?? a ?? '').toLowerCase().replace(/\.exe$/, '')
      return n && (n === exe || exe.includes(n))
    })
    return [...groups.filter(hit), ...groups.filter((g) => !hit(g))]
  }

  function frequent(scope) {
    // 常用 = 收藏 ∪ 发送过的（按「次数 + 新近度」排序）
    const all = []
    for (const g of groupsInScope(scope)) for (const p of g.phrases || []) all.push({ p, g })
    const now = Date.now()
    const rank = ({ p }) => {
      const u = S.usage[p.id]
      const used = u ? Math.log2(1 + u.n) + Math.max(0, 3 - (now - u.t) / 864e5) : 0
      return (p.favorite ? 100 : 0) + used
    }
    return all.filter((x) => x.p.favorite || S.usage[x.p.id]).sort((a, b) => rank(b) - rank(a)).slice(0, 40)
  }

  // 「常用」置顶区：本 scope 内 useCount>0 的话术，次数降序 → 最近使用降序 → 标题；只是视图，仍引用原 phrase
  const TOP_N = 12
  function topUsed(scope) {
    const all = []
    for (const g of groupsInScope(scope)) for (const p of g.phrases || []) if (p.useCount > 0) all.push({ p, g })
    return all.sort((a, b) => (b.p.useCount - a.p.useCount) ||
      ((b.p.lastUsedAt || 0) - (a.p.lastUsedAt || 0)) ||
      String(a.p.title || a.p.content || '').localeCompare(String(b.p.title || b.p.content || ''), 'zh-CN')).slice(0, TOP_N)
  }

  // 行布局：左 标题+正文；右 ★ / 填入 / 发送 常显（未连接聊天窗时 usePhrase 会改为复制并提示）
  // fq：常用区的行 —— 已连接时主按钮固定为「发送」、点整行即发送；未连接时只给「复制」
  function rowHtml(p, g, idx, tokens, showGroup, fq = false) {
    const title = String(p.title || '').trim()
    const content = String(p.content || '')
    const media = (p.images?.length || 0) + (p.files?.length || 0)
    const mode = hasTarget() ? defaultMode() : ''
    const tip = hasTarget() ? '' : ' title="未连接聊天窗：将复制到剪贴板"'
    const tc = typeof p.titleColor === 'string' ? p.titleColor.trim() : ''
    const tcStyle = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(tc) ? ` style="color:${tc}"` : ''
    const acts = !fq
      ? `<button data-act="fill" class="${mode === 'fill' ? 'primary' : ''}"${tip}>填入</button>` +
        `<button data-act="send" class="${mode === 'send' ? 'primary' : ''}"${tip}>发送</button>`
      : hasTarget()
        ? `<button data-act="fill">填入</button><button data-act="send" class="primary">发送</button>`
        : `<button data-act="copy" class="primary" title="未连接聊天窗：复制后到聊天窗粘贴">复制</button>`
    return `<div class="row${title ? '' : ' no-title'}${fq ? ' fq' : ''}${S.busyId === p.id ? ' busy' : ''}" data-i="${idx}" data-id="${esc(p.id)}">` +
      (title ? `<div class="t"><span${tcStyle}>${highlight(title, tokens)}</span>` +
        (showGroup && !fq ? `<span class="tag">${esc(g.name)}</span>` : '') +
        (media ? `<span class="tag" title="填入/发送时粘贴图片和附件，请核对目标窗口">+${media} 附件</span>` : '') + `</div>` : '') +
      `<div class="c" title="${esc(content)}">${highlight(snippet(content, tokens), tokens)}</div>` +
      `<div class="acts">` +
        `<button class="star${p.favorite ? ' on' : ''}" data-act="fav" title="${p.favorite ? '取消收藏' : '收藏'}">${p.favorite ? '★' : '☆'}</button>` +
        acts +
      `</div>` +
      `</div>`
  }

  function renderList() {
    const list = $('#list')
    const tokens = tokensOf(S.q)
    const total = (S.library.groups || []).reduce((n, g) => n + (g.phrases?.length || 0), 0)
    S.rows = []
    let html = ''

    if (!total) {
      list.innerHTML = `<div class="empty"><h3>还没有话术</h3>
        <p>把常用回复存成话术，搜索 → 点一下就能填入或发送到聊天窗。<br>支持各平台商家工作台与网页版客服窗。</p>
        <div class="btns"><button class="btn primary" data-empty="manage">添加话术</button><button class="btn" data-empty="sample">导入默认公司话术</button><button class="btn" data-empty="feishu">从飞书同步公司话术</button></div></div>`
      return
    }

    const push = (p, g) => { S.rows.push({ p, g }); return S.rows.length - 1 }

    if (tokens.length) {
      const hits = []
      for (const g of groupsInScope(S.scope)) for (const p of g.phrases || []) {
        if (S.favOnly && !p.favorite && !S.usage[p.id]) continue
        const sc = scoreFor(p, tokens)
        if (sc > 0) hits.push({ p, g, sc })
      }
      hits.sort((a, b) => b.sc - a.sc)
      for (const { p, g } of hits.slice(0, 300)) html += rowHtml(p, g, push(p, g), tokens, false)
      if (!hits.length) {
        const other = S.scope === 'company' ? 'private' : 'company'
        let n = 0
        for (const g of groupsInScope(other)) for (const p of g.phrases || []) if (scoreFor(p, tokens) > 0) n++
        html = `<div class="empty"><h3>没有找到「${esc(S.q.trim())}」</h3>` +
          (n ? `<p>${other === 'private' ? '私人' : '公司'}话术里有 ${n} 条匹配</p><div class="btns"><button class="btn" data-empty="other">去看看</button></div>`
            : `<p>换个关键词，或用「问 AI」生成回复</p><div class="btns"><button class="btn" data-empty="manage">新建话术</button></div>`) + `</div>`
      }
    } else if (S.favOnly) {
      const items = frequent(S.scope)
      for (const { p, g } of items) html += rowHtml(p, g, push(p, g), tokens, true)
      if (!items.length) html = `<div class="empty"><h3>还没有常用话术</h3><p>点话术右侧的 ☆ 收藏，或发过的话术会自动出现在这里</p></div>`
    } else {
      const groups = groupsInScope(S.scope)
      const top = topUsed(S.scope)
      html += `<div class="ghead fq-head${S.fqCollapsed ? ' collapsed' : ''}" data-g="__frequent"><span class="chev">▾</span>` +
        `<span>常用</span><span class="n">${top.length || ''}</span><span class="sub">按使用次数</span></div>`
      if (!S.fqCollapsed) {
        for (const { p, g } of top) html += rowHtml(p, g, push(p, g), tokens, false, true)
        if (!top.length) html += `<div class="fq-empty">暂无常用，发送或填入后会出现在这里</div>`
      }
      for (const g of groups) {
        const phrases = g.phrases || []
        const collapsed = S.collapsed.has(g.id)
        html += `<div class="ghead${collapsed ? ' collapsed' : ''}" data-g="${esc(g.id)}"><span class="chev">▾</span>` +
          (g.color ? `<span class="gdot" style="background:${esc(g.color)}"></span>` : '') +
          `<span>${esc(g.name)}</span><span class="n">${phrases.length}</span></div>`
        if (!collapsed) for (const p of phrases) html += rowHtml(p, g, push(p, g), tokens, false)
      }
      if (!groups.length || !groups.some((g) => g.phrases?.length)) {
        html += `<div class="empty"><h3>${S.scope === 'private' ? '私人' : '公司'}话术为空</h3><p>${S.scope === 'private' ? '私人话术只有你自己能看到，适合个人习惯用语' : '公司话术为团队统一口径'}</p><div class="btns"><button class="btn" data-empty="manage">去添加</button></div></div>`
      }
    }

    list.innerHTML = html
    if (S.active >= S.rows.length) S.active = S.rows.length - 1
    if (tokens.length && S.active < 0 && S.rows.length) S.active = 0
    paintActive(false)
  }

  function paintActive(scroll = true) {
    const list = $('#list')
    list.querySelectorAll('.row.active').forEach((el) => el.classList.remove('active'))
    if (S.active < 0) return
    const el = list.querySelector(`.row[data-i="${S.active}"]`)
    if (!el) return
    el.classList.add('active')
    if (scroll) el.scrollIntoView({ block: 'nearest' })
  }

  function renderScope() {
    document.querySelectorAll('#scopeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.scope === S.scope))
    $('#favFilter').classList.toggle('on', !!S.favOnly)
    $('#favFilter').title = S.favOnly ? '显示全部话术' : '只看常用（收藏 + 最近发过）'
    $('#q').placeholder = S.favOnly ? '在常用中搜索（支持拼音、首字母）' : `搜索${S.scope === 'private' ? '私人' : '公司'}话术（支持拼音、首字母）`
  }

  // ———————————————————— 动作 ————————————————————
  function bumpUsage(id) {
    const u = S.usage[id] || { n: 0, t: 0 }
    S.usage[id] = { n: u.n + 1, t: Date.now() }
    LS.set('aikefu.usage.v1', S.usage)
  }

  // 发送/填入真正成功后记一次：写回 library 里的原 phrase（按 id 找，避免 library 重载后拿到旧对象）
  async function countUse(id) {
    let hit = null
    for (const g of S.library.groups || []) { hit = (g.phrases || []).find((x) => x.id === id); if (hit) break }
    if (!hit) return
    hit.useCount = (hit.useCount || 0) + 1
    hit.lastUsedAt = Date.now()
    try { await invoke('save_library', { library: S.library, origin: 'panel-usage' }) } catch (e) { console.warn('[usage] save', e) }
  }

  async function usePhrase(p, act) {
    if (!p || S.busyId) return
    if (act === 'copy' || (!hasTarget() && !(p.images?.length || p.files?.length))) {
      await copyText(p.content || '')
      bumpUsage(p.id)
      toast(hasTarget() ? '已复制' : '已复制，请在聊天窗粘贴（未连接聊天窗）', hasTarget() ? '' : 'warn')
      return
    }
    S.busyId = p.id; renderList()
    let ok = false
    try {
      const r = await invoke('send_phrase', { phraseId: p.id, mode: act })
      bumpUsage(p.id)
      if (r?.unbound || r?.mode === 'clipboard') {
        if (!r?.hasMedia) await copyText(p.content || '')
        toast(r?.message || '已复制，请手动粘贴', 'warn')
      } else if (r && r.ok === false) {
        if (!r?.hasMedia) await copyText(p.content || '')
        toast(sendFailureMessage(r), 'err')
      } else {
        toast(r?.message || (r?.verify === 'match' ? (act === 'send' ? '已执行发送（粘贴已验证）' : '已填入，确认后回车发送') : (act === 'send' ? '已执行发送，粘贴未验证' : '已执行粘贴，未验证输入内容')), r?.verify === 'match' ? '' : 'warn')
        ok = true
      }
    } catch (e) {
      if (!(p.images?.length || p.files?.length)) await copyText(p.content || '')
      toast('发送失败：' + (e?.message || e), 'err')
    } finally {
      S.busyId = null; renderList()
    }
    if (ok) countUse(p.id)
  }

  async function saveLibrary() {
    try { await invoke('save_library', { library: S.library, origin: 'panel' }) } catch (e) { toast('保存失败：' + (e?.message || e), 'err') }
  }

  async function toggleFav(p) {
    p.favorite = !p.favorite
    p.updatedAt = Date.now()
    renderList()
    await saveLibrary()
  }

  // 导入默认公司话术（种子：panel/default-company-library.json），重新生成 id，同名公司分组跳过
  async function addSamples() {
    let seed
    try {
      const r = await fetch('panel/default-company-library.json', { cache: 'no-store' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      seed = await r.json()
    } catch (e) { toast('加载默认公司话术失败：' + (e?.message || e), 'err'); return }
    const groups = S.library.groups || (S.library.groups = [])
    const has = new Set(groups.filter((g) => scopeOf(g) === 'company').map((g) => g.name))
    const now = Date.now()
    const add = []
    for (const g of seed?.groups || []) {
      if (has.has(g.name)) continue
      const secMap = {}
      const sections = (g.sections || []).map((x) => { const id = uid(); secMap[x.id] = id; return { ...x, id } })
      const phrases = (g.phrases || []).map((p) => ({ ...p, id: uid(), section: p.section ? (secMap[p.section] || null) : null, favorite: false, createdAt: now, updatedAt: now }))
      add.push({ ...g, id: uid(), scope: 'company', apps: g.apps || [], sections, phrases })
    }
    if (!add.length) { toast('默认公司话术已在库中'); return }
    groups.push(...add)
    S.scope = 'company'; LS.set('aikefu.scope', S.scope)
    renderScope(); renderList()
    await saveLibrary()
    const n = add.reduce((t, g) => t + g.phrases.length, 0)
    toast(`已导入 ${add.length} 个分组、${n} 条默认公司话术`)
  }

  // ———————————————————— 问 AI ————————————————————
  async function askAi() {
    S.aiDraft = ''; S.aiPick = 0; S.aiCollected = ''
    renderAi({ phase: 'running', question: null })
    try {
      const st = await invoke('assist_trigger')
      if (st) onAssist(st)
    } catch (e) {
      onAssist({ phase: 'error', message: String(e?.message || e) })
    }
  }

  function onAssist(st) {
    const prev = S.assist
    S.assist = st || { phase: 'idle' }
    if (S.assist.phase === 'ready' && (prev.phase !== 'ready' || prev.result?.reply !== S.assist.result?.reply)) {
      S.aiDraft = S.assist.result?.reply || ''
      S.aiPick = 0
      S.aiCollected = ''
    }
    renderAi(S.assist)
  }

  function aiOptions() {
    const r = S.assist.result
    if (!r) return []
    const alts = (r.evidence || []).filter((e) => e.kind === 'alt').map((e) => e.content)
    return [r.reply, ...alts].filter(Boolean)
  }

  function renderAi(st) {
    const box = $('#ai')
    const phase = st?.phase || 'idle'
    $('#askBtn').disabled = phase === 'running'
    if (phase === 'idle') { box.hidden = true; box.innerHTML = ''; return }
    box.hidden = false
    const q = st.question ? `<div class="ai-q" title="${esc(st.question)}"><b>买家：</b>${esc(st.question)}</div>` : ''
    const close = `<button class="link" data-ai="close" title="关闭 (Esc)">关闭</button>`

    if (phase === 'running') {
      box.innerHTML = `<div class="ai-head"><span class="spinner"></span><span>正在生成回复…</span><span class="grow"></span>${close}</div>${q}`
      return
    }
    if (phase === 'ready') {
      const opts = aiOptions()
      const unbound = !hasTarget()
      box.innerHTML = `<div class="ai-head"><span>AI 建议回复</span><span class="grow"></span>${close}</div>${q}` +
        (opts.length > 1 ? `<div class="ai-alts">${opts.map((_, i) => `<button data-pick="${i}" class="${i === S.aiPick ? 'on' : ''}">${i === 0 ? '推荐' : '备选 ' + i}</button>`).join('')}</div>` : '') +
        `<textarea id="aiText" rows="3" spellcheck="false"></textarea>` +
        `<div class="ai-actions"><span class="hint">${unbound ? '可修改后复制' : 'Ctrl+Enter 发送'}</span>` +
        (unbound
          ? `<button class="btn primary" data-ai="copy">复制</button>`
          : `<button class="btn" data-ai="copy">复制</button><button class="btn" data-ai="fill">填入</button><button class="btn primary" data-ai="send">发送</button>`) +
        `</div>` +
        `<div class="ai-collect"><button class="link" data-ai="collect" title="把「买家问题 + 当前这条回复」存为私人话术">＋ 收录为话术</button></div>`
      const ta = $('#aiText')
      ta.value = S.aiDraft
      ta.addEventListener('input', () => { S.aiDraft = ta.value })
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); aiUse(hasTarget() ? 'send' : 'copy') }
        if (e.key === 'Escape') { e.preventDefault(); aiClose() }
      })
      return
    }
    // invalid / error / 其它
    const msg = st.message || (phase === 'invalid' ? '剪贴板里没有文字' : '生成失败')
    const isEmptyClip = phase === 'invalid'
    box.innerHTML = `<div class="ai-head"><span>${isEmptyClip ? '先复制买家消息' : '问 AI 失败'}</span><span class="grow"></span>${close}</div>` +
      `<div class="ai-msg${isEmptyClip ? '' : ' err'}">${isEmptyClip ? '在聊天窗选中买家的话，按 <b>Ctrl+C</b> 复制，再点「问 AI」。<br>AI 只读取剪贴板，不会读取或识别聊天窗口。' : esc(msg)}</div>` +
      `<div class="ai-actions"><span class="hint"></span><button class="btn primary" data-ai="retry">${isEmptyClip ? '已复制，再试一次' : '重试'}</button></div>`
  }

  async function aiUse(act) {
    const text = (S.aiDraft || '').trim()
    if (!text) { toast('回复内容为空', 'warn'); return }
    if (act === 'copy' || !hasTarget()) {
      await copyText(text)
      toast(hasTarget() ? '已复制' : '已复制，请在聊天窗粘贴（未连接聊天窗）', hasTarget() ? '' : 'warn')
      return
    }
    try {
      const r = await invoke('assist_send', { mode: act, text })
      if (r?.unbound || r?.mode === 'clipboard') { await copyText(text); toast(r?.message || '已复制，请手动粘贴', 'warn'); return }
      if (r && r.ok === false) { await copyText(text); toast(sendFailureMessage(r), 'err'); return }
      toast(r?.verify === 'match' ? (act === 'send' ? '已执行发送（粘贴已验证）' : '已填入，确认后回车发送') : (act === 'send' ? '已执行发送，粘贴未验证' : '已执行粘贴，未验证输入内容'), r?.verify === 'match' ? '' : 'warn')
      aiClose()
    } catch (e) {
      await copyText(text)
      toast('发送失败，已复制：' + (e?.message || e), 'err')
    }
  }

  // 收录：标题=买家问题（截断），正文=当前编辑框里的回复，写入私人话术（第一个私人分组，没有则新建「私人」）
  async function aiCollect() {
    const content = (S.aiDraft || '').trim()
    if (!content) { toast('回复内容为空', 'warn'); return }
    if (S.aiCollected === content) { toast('这条已收录过了'); return }
    const q = String(S.assist?.question || '').replace(/\s+/g, ' ').trim()
    const title = (q || content).slice(0, 24) + ((q || content).length > 24 ? '…' : '')
    const groups = S.library.groups || (S.library.groups = [])

    // 并入已有私人分组，绝不新建「AI 收录」；若库里已有该分组则把话术合并进第一个私人分组后删掉
    const junk = groups.filter((x) => String(x.name || '').trim() === 'AI 收录')
    let g = groups.find((x) => scopeOf(x) === 'private' && String(x.name || '').trim() !== 'AI 收录')
    let created = false
    if (!g) {
      g = { id: uid(), name: '私人', color: null, apps: [], scope: 'private', sections: [], phrases: [] }
      groups.push(g)
      created = true
    }
    for (const j of junk) {
      if (j === g) continue
      g.phrases = g.phrases || []
      for (const ph of (j.phrases || [])) g.phrases.push(ph)
      const ix = groups.indexOf(j)
      if (ix >= 0) groups.splice(ix, 1)
    }

    const now = Date.now()
    g.phrases = g.phrases || []
    g.phrases.unshift({ id: uid(), title, content, titleColor: null, images: [], files: [], hotkey: null, favorite: false, section: null, createdAt: now, updatedAt: now })
    try {
      await invoke('save_library', { library: S.library, origin: 'panel' })
      S.aiCollected = content
      renderList()
      toast('已收录到私人话术「' + (g.name || '私人') + '」')
    } catch (e) {
      g.phrases.shift()
      if (created) {
        const ix = groups.indexOf(g)
        if (ix >= 0) groups.splice(ix, 1)
      }
      toast('收录失败：' + (e?.message || e), 'err')
    }
  }

  function aiClose() {
    S.assist = { phase: 'idle' }
    renderAi(S.assist)
    invoke('assist_discard').catch(() => {})
  }

  // ———————————————————— 浮层菜单 ————————————————————
  function openPop(anchor, html, onClick) {
    const pop = $('#pop')
    pop.innerHTML = html
    pop.hidden = false
    const r = anchor.getBoundingClientRect()
    const w = Math.min(pop.offsetWidth, window.innerWidth - 16)
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)
    if (anchor.id === 'menuBtn') left = Math.max(8, r.right - w)
    pop.style.left = left + 'px'
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8) + 'px'
    pop.onclick = (e) => {
      const it = e.target.closest('[data-k]')
      if (!it) return
      closePop()
      onClick(it.dataset.k, it.dataset)
    }
  }
  function closePop() { const pop = $('#pop'); pop.hidden = true; pop.innerHTML = '' }

  const item = (k, label, { check = null, sub = '', extra = '' } = {}) =>
    `<button class="item" data-k="${k}" ${extra}>${check === null ? '' : `<span class="check">${check ? '✓' : ''}</span>`}<span class="grow">${esc(label)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</button>`

  function openTargetMenu() {
    const p = S.settings?.panel || {}
    const t = S.target
    let html = ''
    if (hasTarget()) {
      html += `<div class="note">${t.bound ? '已锁定' : '正在跟随'}：${esc(t.title || t.exe)}</div>`
      html += t.bound ? item('unpin', '解除锁定（恢复自动跟随）') : item('pin', '锁定这个窗口')
    } else {
      html += `<div class="note">切到商家工作台或网页版客服窗口，会自动跟随；也可以手动指定。</div>`
    }
    html += item('pick', '选择聊天窗…')
    html += `<div class="sep"></div>`
    html += item('autoBind', '自动跟随前台聊天软件', { check: p.autoBind !== false })
    html += item('docked', '面板贴靠在聊天窗旁', { check: !!p.docked })
    if (p.docked) html += item('side', '贴靠位置', { sub: p.side === 'left' ? '左侧' : '右侧' })
    openPop($('#targetBtn'), html, async (k) => {
      if (k === 'pin') await invoke('pin_target')
      else if (k === 'unpin') await invoke('unpin_target')
      else if (k === 'pick') openWindowPicker()
      else if (k === 'autoBind') await patchSettings({ panel: { autoBind: !(p.autoBind !== false) } })
      else if (k === 'docked') await patchSettings({ panel: { docked: !p.docked } })
      else if (k === 'side') await patchSettings({ panel: { side: p.side === 'left' ? 'right' : 'left' } })
    })
  }

  async function openWindowPicker() {
    openPop($('#targetBtn'), `<div class="note"><span class="spinner" style="display:inline-block;vertical-align:-2px"></span> 正在列出窗口…</div>`, () => {})
    let apps = []
    try { apps = await invoke('list_open_apps') } catch { /* ignore */ }
    apps = (apps || []).filter((a) => a.title && !/AI客服/.test(a.title))
    if (!apps.length) {
      openPop($('#targetBtn'), `<div class="note">没有找到可用窗口（仅 Windows 支持选择窗口）</div>`, () => {})
      return
    }
    const html = `<div class="sec">选择要发送到的聊天窗</div>` +
      apps.slice(0, 40).map((a) => item('w', a.title, { sub: String(a.exe || '').replace(/\.exe$/i, ''), extra: `data-hwnd="${a.hwnd}" title="${esc(a.title)}"` })).join('')
    openPop($('#targetBtn'), html, async (_k, ds) => {
      try { await invoke('pin_window', { hwnd: Number(ds.hwnd) }); toast('已锁定该窗口') } catch (e) { toast('锁定失败：' + (e?.message || e), 'err') }
    })
  }

  function openMainMenu() {
    const s = S.settings || {}
    const mode = defaultMode()
    const theme = s.theme || 'auto'
    const pasteDelays = [80, 150, 300, 500, 800, 1200]
    const pasteDelay = s.send?.pasteDelayMs ?? 80
    const html =
      item('manage', '管理话术') +
      item('settings', '设置') +
      item('feishu', '从飞书同步公司话术') +
      `<div class="sep"></div><div class="sec">点击话术时</div>` +
      item('mode-send', '直接发送', { check: mode === 'send' }) +
      item('mode-fill', '只填入，不回车', { check: mode === 'fill' }) +
      item('paste-delay', '粘贴延迟', { sub: pasteDelay + ' ms（点击切换）' }) +
      item('restore-clipboard', '恢复剪贴板', { check: s.send?.restoreClipboard !== false }) +
      item('send-logs', '打开发送日志') +
      `<div class="sep"></div>` +
      item('top', '窗口置顶', { check: s.panel?.alwaysOnTop !== false }) +
      item('theme', '外观', { sub: { auto: '跟随系统', light: '浅色', dark: '深色' }[theme] || '跟随系统' }) +
      `<div class="sep"></div>` +
      `<div class="note">Enter 执行 · Ctrl+Enter 另一种方式 · Alt+1~9 快选<br>${esc(s.hotkeys?.togglePanel || 'Ctrl+Alt+K')} 显隐 · ${esc(s.hotkeys?.focusSearch || 'Ctrl+Alt+F')} 搜索</div>` +
      `<div class="sep"></div>` +
      item('quit', '退出 AI客服')
    openPop($('#menuBtn'), html, async (k) => {
      if (k === 'manage') invoke('open_manager', { tab: 'library' })
      else if (k === 'feishu') openFeishuChooser()
      else if (k === 'settings') invoke('open_manager', { tab: 'settings' })
      else if (k === 'mode-send') await patchSettings({ send: { mode: 'send' } })
      else if (k === 'mode-fill') await patchSettings({ send: { mode: 'fill' } })
      else if (k === 'paste-delay') await patchSettings({ send: { pasteDelayMs: pasteDelays[(pasteDelays.indexOf(pasteDelay) + 1) % pasteDelays.length] } })
      else if (k === 'restore-clipboard') await patchSettings({ send: { restoreClipboard: !(s.send?.restoreClipboard !== false) } })
      else if (k === 'send-logs') { try { await invoke('open_send_logs') } catch (e) { toast('打开日志失败：' + (e?.message || e), 'err') } }
      else if (k === 'top') await patchSettings({ panel: { alwaysOnTop: !(s.panel?.alwaysOnTop !== false) } })
      else if (k === 'theme') await patchSettings({ theme: { auto: 'light', light: 'dark', dark: 'auto' }[theme] || 'light' })
      else if (k === 'quit') invoke('quit_app')
    })
  }

  async function patchSettings(patch) {
    try {
      const r = await invoke('update_settings', { patch })
      if (r?.settings) applySettings(r.settings)
    } catch (e) { toast('设置保存失败：' + (e?.message || e), 'err') }
  }

  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  function applyTheme() {
    const t = S.settings?.theme || 'auto'
    const dark = t === 'dark' || (t !== 'light' && mql.matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }
  function applySettings(s) {
    S.settings = s
    applyTheme()
    renderList()
    if (S.assist.phase === 'ready') renderAi(S.assist)
  }

  // ———————————————————— 事件绑定 ————————————————————
  function bind() {
    const q = $('#q')
    q.addEventListener('input', () => {
      S.q = q.value
      $('#clearQ').hidden = !S.q
      S.active = S.q.trim() ? 0 : -1
      renderList()
      $('#list').scrollTop = 0
    })
    $('#clearQ').addEventListener('click', () => { q.value = ''; q.dispatchEvent(new Event('input')); q.focus() })

    document.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return
      const inAi = e.target.id === 'aiText'
      if (e.key === 'Escape') {
        if (!$('#pop').hidden) { closePop(); return }
        if (inAi) return
        if (S.q) { q.value = ''; q.dispatchEvent(new Event('input')); return }
        if (S.assist.phase !== 'idle') { aiClose(); return }
        return
      }
      if (inAi) return
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        const r = S.rows[Number(e.key) - 1]
        if (r) { e.preventDefault(); usePhrase(r.p, hasTarget() ? defaultMode() : 'copy') }
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!S.rows.length) return
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        S.active = S.active < 0 ? (d > 0 ? 0 : S.rows.length - 1) : Math.max(0, Math.min(S.rows.length - 1, S.active + d))
        paintActive()
        return
      }
      if (e.key === 'Enter' && (e.target === q || e.target === document.body || e.target.id === 'list')) {
        const r = S.rows[S.active]
        if (!r) return
        e.preventDefault()
        const mode = defaultMode()
        const act = !hasTarget() ? 'copy' : ((e.ctrlKey || e.metaKey) ? (mode === 'send' ? 'fill' : 'send') : mode)
        usePhrase(r.p, act)
        return
      }
      // 在任意位置直接打字 → 进入搜索
      if (e.target !== q && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
        q.focus()
      }
    })

    $('#list').addEventListener('click', (e) => {
      const emptyBtn = e.target.closest('[data-empty]')
      if (emptyBtn) {
        const k = emptyBtn.dataset.empty
        if (k === 'manage') invoke('open_manager', { tab: 'library' })
        else if (k === 'sample') addSamples()
        else if (k === 'feishu') openFeishuChooser()
        else if (k === 'other') { S.scope = S.scope === 'company' ? 'private' : 'company'; LS.set('aikefu.scope', S.scope); renderScope(); renderList() }
        return
      }
      const gh = e.target.closest('.ghead')
      if (gh) {
        const id = gh.dataset.g
        if (id === '__frequent') {
          S.fqCollapsed = !S.fqCollapsed
          LS.set('aikefu.collapse.frequent', S.fqCollapsed)
          renderList()
          return
        }
        if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id)
        LS.set('aikefu.collapsed', [...S.collapsed])
        renderList()
        return
      }
      const row = e.target.closest('.row')
      if (!row) return
      const r = S.rows[Number(row.dataset.i)]
      if (!r) return
      S.active = Number(row.dataset.i)
      const btn = e.target.closest('[data-act]')
      const act = btn?.dataset.act
      if (act === 'fav') { toggleFav(r.p); return }
      // 常用区：点整行就发送（已连接时），少一步
      const dflt = !hasTarget() ? 'copy' : (row.classList.contains('fq') ? 'send' : defaultMode())
      usePhrase(r.p, act || dflt)
    })

    $('#list').addEventListener('mousemove', (e) => {
      const row = e.target.closest('.row')
      if (!row) return
      const i = Number(row.dataset.i)
      if (i !== S.active) { S.active = i; paintActive(false) }
    })

    $('#scopeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-scope]')
      if (!b || b.dataset.scope === S.scope) return
      S.scope = b.dataset.scope
      LS.set('aikefu.scope', S.scope)
      S.active = S.q.trim() ? 0 : -1
      renderScope(); renderList()
      $('#list').scrollTop = 0
    })

    $('#favFilter').addEventListener('click', () => {
      S.favOnly = !S.favOnly
      LS.set('aikefu.favOnly', S.favOnly)
      renderScope(); renderList()
      $('#list').scrollTop = 0
    })

    $('#askBtn').addEventListener('click', askAi)
    $('#targetBtn').addEventListener('click', openTargetMenu)
    $('#menuBtn').addEventListener('click', openMainMenu)
    $('#hideBtn').addEventListener('click', () => invoke('hide_panel'))

    $('#ai').addEventListener('click', (e) => {
      const pick = e.target.closest('[data-pick]')
      if (pick) {
        S.aiPick = Number(pick.dataset.pick)
        S.aiDraft = aiOptions()[S.aiPick] || ''
        renderAi(S.assist)
        return
      }
      const b = e.target.closest('[data-ai]')
      if (!b) return
      const k = b.dataset.ai
      if (k === 'close') aiClose()
      else if (k === 'retry') askAi()
      else if (k === 'collect') aiCollect()
      else aiUse(k)
    })

    document.addEventListener('mousedown', (e) => {
      if (!$('#pop').hidden && !e.target.closest('#pop') && !e.target.closest('#menuBtn, #targetBtn')) closePop()
    })
    window.addEventListener('blur', closePop)
    mql.addEventListener?.('change', applyTheme)
  }

  // ———————————————————— 启动 ————————————————————
  let syncingFeishu = false
  function openFeishuChooser() {
    const last = S.settings?.feishuLibraryRegion || 'domestic'
    openPop($('#menuBtn'), '<div class="sec">选择公司主库</div>' +
      item('domestic', '同步国内公司主库', { check: last === 'domestic' }) +
      item('overseas', '同步海外公司主库', { check: last === 'overseas' }),
      (region) => syncFeishu(region))
  }
  async function syncFeishu(region) {
    if (syncingFeishu) return
    syncingFeishu = true
    toast(`正在同步${region === 'overseas' ? '海外' : '国内'}公司主库…`)
    try {
      const result = await invoke('sync_company_from_feishu', { region })
      S.settings.feishuLibraryRegion = region
      if (result?.ok) await loadLibrary()
      toast(result?.message || '同步失败', result?.ok ? '' : 'err')
    } catch (e) { toast('同步失败：' + (e?.message || e), 'err') }
    finally { syncingFeishu = false }
  }

  async function loadLibrary() {
    try { S.library = (await invoke('get_library')) || { groups: [] } } catch (e) { console.error(e) }
    renderList()
    warmPinyin()
  }

  // 空闲时分批预热拼音缓存，避免首次输入时卡顿
  function warmPinyin() {
    const texts = []
    for (const g of S.library.groups || []) for (const p of g.phrases || []) texts.push(String(p.title || ''), String(p.content || ''))
    const idle = window.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 16))
    let i = 0
    const step = (dl) => {
      while (i < texts.length && dl.timeRemaining() > 2) pyInfo(texts[i++])
      if (i < texts.length) idle(step)
    }
    idle(step)
  }

  async function boot() {
    bind()
    renderScope()
    const [settings, target, assist] = await Promise.all([
      invoke('get_settings').catch(() => null),
      invoke('get_target').catch(() => null),
      invoke('get_assist_state').catch(() => null),
    ])
    S.target = target
    renderTarget()
    if (settings) { S.settings = settings; applyTheme() }
    await loadLibrary()
    // 首次空库：自动灌入默认公司话术（与「导入默认公司话术」同一份种子）
    try {
      const companyN = (S.library.groups || []).filter((g) => scopeOf(g) === 'company')
        .reduce((n, g) => n + (g.phrases?.length || 0), 0)
      if (companyN === 0) await addSamples()
    } catch (e) { console.warn('[boot] auto seed', e) }
    if (assist && assist.phase !== 'idle') onAssist(assist)

    listen('library-changed', loadLibrary)
    listen('settings-changed', (s) => s && applySettings(s))
    listen('target-changed', (t) => {
      const had = hasTarget(); const prevBound = S.target?.bound
      S.target = t
      renderTarget()
      if (had !== hasTarget() || prevBound !== t?.bound) { renderList(); if (S.assist.phase === 'ready') renderAi(S.assist) }
    })
    listen('assist-state', onAssist)
    listen('focus-search', () => { const q = $('#q'); q.focus(); q.select() })

    $('#q').focus()
  }

  if (!T) {
    document.body.innerHTML = '<p style="padding:20px;color:#888">请在 AI客服 应用内打开此页面</p>'
  } else {
    boot().catch((e) => { console.error(e); toast('启动失败：' + (e?.message || e), 'err') })
  }
})()

function sendFailureMessage(r) {
  const err = String(r?.error || '').trim()
  if (/elevation-mismatch/i.test(`${err} ${r?.message || ''}`)) {
    return '京东工作台以管理员运行，请右键以管理员身份运行 AI客服（elevation-mismatch）'
  }
  if (/activation failed/i.test(err) || /activation failed/i.test(r?.message || '')) {
    return '没能切到聊天窗（Target activation failed），内容已复制；可点目标按钮重新「选择聊天窗…」'
  }
  if (err && r?.message) return `${r.message}（${err}）`
  if (err) return `没能发到聊天窗（${err}），内容已复制，请手动粘贴`
  return r?.message || '没能发到聊天窗，内容已复制，请手动粘贴'
}

