'use strict'
const fs = require('node:fs')

class RetryableError extends Error {}

function responsesUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  return /\/responses$/.test(b) ? b : `${b}/responses`
}

function chatCompletionsUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(b)) return b
  if (/\/responses$/.test(b)) return b.replace(/\/responses$/, '/chat/completions')
  return `${b}/chat/completions`
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text
  return (data?.output ?? [])
    .filter((o) => o?.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((c) => typeof c?.text === 'string').map((c) => c.text).join('')
  }
  return ''
}

async function postJson(url, payload, cfg, opts, label) {
  const timeoutMs = opts.timeoutMs ?? 60000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const fetchImpl = opts.fetchImpl || fetch
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const bodyText = await res.text()
    if (!res.ok) {
      let msg = bodyText.slice(0, 300)
      try { msg = JSON.parse(bodyText)?.error?.message ?? msg } catch { /* keep */ }
      const Err = (res.status === 429 || res.status >= 500) ? RetryableError : Error
      const err = new Err(`${label} 返回 ${res.status}：${msg}`)
      err.status = res.status
      throw err
    }
    try {
      return JSON.parse(bodyText)
    } catch {
      throw new RetryableError(`${label} 返回了无法解析的内容：${bodyText.slice(0, 120)}`)
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error(`LLM 请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
      err.isTimeout = true
      throw err
    }
    if (e instanceof TypeError) throw new RetryableError(`网络错误：${e.message}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function callResponsesOnce(cfg, messages, opts) {
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const input = messages.filter((m) => m.role !== 'system')
  const data = await postJson(
    responsesUrl(cfg.baseUrl),
    {
      model: cfg.model,
      ...(instructions ? { instructions } : {}),
      input,
      temperature: cfg.temperature ?? 0.4,
      max_output_tokens: opts.maxTokens ?? 1200,
      stream: false,
    },
    cfg,
    opts,
    'LLM 接口',
  )
  if (data?.error) throw new RetryableError(`LLM 接口错误：${data.error.message ?? JSON.stringify(data.error)}`)
  const content = extractOutputText(data)
  if (!content.trim()) throw new RetryableError('LLM 返回内容为空')
  return content
}

async function callChatCompletionsOnce(cfg, messages, opts) {
  const data = await postJson(
    chatCompletionsUrl(cfg.baseUrl),
    {
      model: cfg.model,
      messages,
      temperature: cfg.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1200,
      stream: false,
    },
    cfg,
    opts,
    'Chat Completions',
  )
  const content = extractChatText(data)
  if (!content.trim()) throw new RetryableError('Chat Completions 返回为空')
  return content
}

function shouldFallbackToChatCompletions(err) {
  if (!err) return false
  // Never waste another full timeout or retry invalid credentials on a second endpoint.
  if (err.isTimeout || err.status === 401 || err.status === 403) return false
  return true
}

async function callLlm(cfg, messages, opts = {}) {
  let retries = opts.retries ?? 1
  let lastErr
  for (;;) {
    try {
      return await callResponsesOnce(cfg, messages, opts)
    } catch (e) {
      lastErr = e
      if (e instanceof RetryableError && retries-- > 0) {
        await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 600))
        continue
      }
      break
    }
  }
  if (!shouldFallbackToChatCompletions(lastErr)) {
    throw lastErr
  }
  try {
    return await callChatCompletionsOnce(cfg, messages, opts)
  } catch (e2) {
    throw lastErr instanceof Error ? lastErr : e2
  }
}

function resolveApiKey(settingsKey, fileCandidates) {
  const fromEnv = (process.env.AIKEFU_LLM_API_KEY || process.env.NEXTOP_LLM_API_KEY || '').trim()
  if (fromEnv) return fromEnv
  for (const p of fileCandidates || []) {
    try {
      if (p && fs.existsSync(p)) {
        const v = fs.readFileSync(p, 'utf8').trim()
        if (v) return v
      }
    } catch { /* ignore */ }
  }
  return String(settingsKey || '').trim()
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 3)}…${key.slice(-2)}`
}

module.exports = { RetryableError, extractOutputText, callLlm, resolveApiKey, maskKey }
