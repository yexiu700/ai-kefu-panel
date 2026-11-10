'use strict'
const path = require('node:path')
const os = require('node:os')
const { clipboard } = require('electron')
const store = require('./store')
const { callLlm, resolveApiKey, maskKey } = require('./llm')

const DEFAULT_BASE = 'https://x.arzopa.com/v1'
// 安装包内置默认网关 Key（可被环境变量 / 本地 llm_api_key 覆盖）
const BUNDLED_API_KEY = ''
const DEFAULT_MODEL = 'gemini-3.8-flash-high'
const DEFAULT_PROMPT =
  '你是电商客服助手。任务：根据买家消息直接写出可复制发送的回复文案。硬性规则：1) 只输出给买家看的回复，不要反问用户/客服、不要澄清、不要让对方补充信息到「你」这边；2) 不要输出分析过程、不要说「作为AI」；3) 语言必须跟随买家：买家用什么语言就用什么语言回复（英文买家必须用英文，勿默认中文）；先共情一句再给明确下一步或政策说明；4) 不要编造物流单号、订单号或未授权赔偿；5) 信息不足时，也要给一条礼貌的过渡回复，并把需要的信息写成对买家说的问句（与买家同语言），而不是向操作者提问。'

/** @type {any} */
let assistState = idleState()

function idleState(message = null) {
  return { phase: 'idle', result: null, message, question: null }
}

function keyCandidates() {
  const home = os.homedir()
  return [
    path.join(home, '.huiyou', 'llm_api_key'),
    path.join(home, '.config', 'huiyou', 'llm_api_key'),
    path.join(store.getDataDir(), 'llm_api_key'),
    path.join(__dirname, '..', '.api_key'),
    '/workspace/nextop-suggest-reply/.api_key',
  ]
}

function getApiKey() {
  return resolveApiKey(BUNDLED_API_KEY, keyCandidates())
}

function retrieveEvidence(library, query, topN = 5) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const tokens = q.split(/[\s,，。.!！？?；;、]+/).filter((t) => t.length >= 1)
  const hits = []
  for (const g of library.groups || []) {
    for (const p of g.phrases || []) {
      const title = String(p.title || '')
      const content = String(p.content || '')
      const blob = `${title}\n${content}`.toLowerCase()
      let score = 0
      if (title.toLowerCase().includes(q)) score += 10
      if (content.toLowerCase().includes(q)) score += 5
      for (const t of tokens) {
        if (t.length < 2) continue
        if (title.toLowerCase().includes(t)) score += 3
        else if (blob.includes(t)) score += 1
      }
      if (score > 0) {
        hits.push({
          kind: 'phrase',
          id: p.id,
          title: title || content.slice(0, 24) || '话术',
          content: content.slice(0, 800),
          score,
          groupName: g.name,
        })
      }
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topN).map(({ kind, id, title, content }) => ({ kind, id, title, content }))
}


function sanitizeReply(text) {
  let s = String(text || '').trim()
  // 去掉模型偶尔加的「回复：」「客服：」前缀
  s = s.replace(/^(?:回复|建议回复|客服回复|可以这样回)[:：]\s*/u, '')
  // 若整段明显在问操作者，包一层对买家的过渡话
  if (/^(?:请问您|你能|您能|能否|方便告诉我|需要我|请提供|请补充|我需要知道)/u.test(s) && !/亲|宝|客户|您看|您方便/.test(s.slice(0, 8))) {
    // keep as-is if already addressing buyer with 您; otherwise still return — prompt should prevent
  }
  return s.trim()
}

function parseAssistRaw(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const tryObj = (s) => {
    try {
      const obj = JSON.parse(s)
      const reply =
        (typeof obj.reply === 'string' && obj.reply) ||
        (typeof obj.text === 'string' && obj.text) ||
        (typeof obj.suggestion === 'string' && obj.suggestion) ||
        ''
      const alternatives = Array.isArray(obj.alternatives)
        ? obj.alternatives.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2)
        : []
      if (reply.trim()) return { reply: reply.trim(), alternatives }
      return null
    } catch {
      return null
    }
  }
  let parsed = tryObj(cleaned)
  if (!parsed) {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) parsed = tryObj(m[0])
  }
  if (parsed) return parsed
  return { reply: cleaned.trim(), alternatives: [] }
}

function setState(next) {
  assistState = next
  try {
    const { emitAll } = require('./handlers')
    emitAll('assist-state', assistState)
  } catch (e) {
    console.warn('[assist] emit failed', e)
  }
  return assistState
}

function getAssistState() {
  return assistState
}

async function runLlmReply(question) {
  const context = String(question || '').trim().slice(0, 8000)
  if (!context) {
    return setState({
      phase: 'invalid',
      question: null,
      message: '请先复制买家问题到剪贴板，再点「问 AI」（不会读取/OCR 聊天窗口）',
      result: null,
    })
  }
  const apiKey = getApiKey()
  if (!apiKey) {
    return setState({
      phase: 'error',
      question: context,
      message: '未配置 API Key：请设环境变量 HUIYOU_LLM_API_KEY / NEXTOP_LLM_API_KEY，或写入 %USERPROFILE%\\.huiyou\\llm_api_key',
      result: null,
    })
  }

  setState({ phase: 'running', question: context, message: null, result: null })
  const library = store.loadLibrary()
  const evidence = retrieveEvidence(library, context, 5)
  const knowledge = evidence.length
    ? evidence.map((e, i) => `[${i + 1}] ${e.title}\n${e.content}`).join('\n\n')
    : '（话术库暂无高相关条目，请按通用客服礼貌简短回复，语言跟随买家。）'

  const user = `以下是买家发来的消息（或聊天片段）。请直接写客服回复，不要向我（操作者）提问或要求澄清。

买家消息：
"""
${context}
"""

参考话术（可借鉴语气与要点，勿照抄无关内容）：
${knowledge}

只输出 JSON（不要 markdown 代码块），字段含义：
- reply：一条可直接发送给买家的简短回复，语言必须与买家消息一致（英文买家用英文；必须是对买家说话，禁止反问操作者）
- alternatives：0～2 条备选回复（同样语言、同样必须是对买家说的话）
{"reply":"...","alternatives":["..."]}`

  try {
    const raw = await callLlm(
      {
        baseUrl: process.env.NEXTOP_LLM_BASE_URL || process.env.HUIYOU_LLM_BASE_URL || DEFAULT_BASE,
        model: process.env.HUIYOU_LLM_MODEL || DEFAULT_MODEL,
        apiKey,
        temperature: 0.35,
      },
      [
        { role: 'system', content: DEFAULT_PROMPT },
        { role: 'user', content: user },
      ],
      { maxTokens: 900, timeoutMs: 60000, retries: 1 },
    )
    const parsed = parseAssistRaw(raw)
    const reply = sanitizeReply(parsed.reply)
    const alternatives = (parsed.alternatives || []).map(sanitizeReply).filter(Boolean)
    if (!reply) {
      return setState({
        phase: 'error',
        question: context,
        message: '模型未返回有效回复',
        result: null,
      })
    }
    const altEvidence = (alternatives || []).map((text, i) => ({
      kind: 'alt',
      id: `alt-${i}`,
      title: `备选 ${i + 1}`,
      content: text,
    }))
    return setState({
      phase: 'ready',
      question: context,
      message: null,
      result: {
        status: 'ok',
        reply,
        question: context,
        // 非 null：跳过「是否同一买家」确认（本地剪贴板路径）
        titleRegion: '剪贴板',
        evidence: [...evidence, ...altEvidence],
        product: null,
        missing: [],
        candidates: [],
        message: null,
        keyHint: maskKey(apiKey),
      },
    })
  } catch (e) {
    return setState({
      phase: 'error',
      question: context,
      message: e instanceof Error ? e.message : String(e),
      result: null,
    })
  }
}

async function assistTrigger() {
  const text = clipboard.readText()
  return runLlmReply(text)
}

async function assistAsk(question) {
  return runLlmReply(question || clipboard.readText())
}

function assistDiscard() {
  return setState(idleState())
}

function assistConfirmSameBuyer() {
  // no-op for clipboard path; keep ready
  return assistState
}

function assistChooseProduct() {
  return assistState
}

function localCloudStatus() {
  // 假登录：让原版 inTeam=true，AI 入口显示「问 AI」并可用
  return {
    available: true,
    account: {
      userId: 'local-shell',
      name: '本地壳',
      phone: '',
      role: 'member',
      team: { id: 'local-team', name: '本地团队' },
      squads: [],
    },
  }
}

module.exports = {
  getAssistState,
  assistTrigger,
  assistAsk,
  assistDiscard,
  assistConfirmSameBuyer,
  assistChooseProduct,
  localCloudStatus,
  getApiKey,
  keyCandidates,
}
