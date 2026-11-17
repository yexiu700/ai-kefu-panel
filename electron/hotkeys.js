'use strict'
const { normalizeExeName } = require('../frontend/panel/send-rule')

/**
 * Normalize frontend hotkey strings (e.g. "Ctrl+Alt+J") into Electron Accelerators ("Control+Alt+J").
 */
function acceleratorFromSetting(raw) {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed
    .replace(/CommandOrControl/gi, 'CommandOrControl')
    .replace(/\bCtrl\b/gi, 'Control')
    .replace(/\bCmd\b/gi, 'Command')
    .replace(/\s*\+\s*/g, '+')
}

function normalizeAcceleratorKey(acc) {
  return String(acc || '').trim().toLowerCase()
}

function isPhraseSendable(phrase) {
  if (!phrase || typeof phrase !== 'object') return false
  if (String(phrase.content || '').trim() !== '') return true
  if (Array.isArray(phrase.images) && phrase.images.length > 0) return true
  if (Array.isArray(phrase.files) && phrase.files.length > 0) return true
  return false
}

function extractGroupApps(group) {
  if (!Array.isArray(group?.apps)) return []
  return group.apps
    .map((a) => normalizeExeName(a?.exe ?? a?.name ?? a ?? ''))
    .filter(Boolean)
}

function isGroupApplicableToExe(group, targetExe) {
  const apps = extractGroupApps(group)
  if (!apps.length) return true
  const exe = normalizeExeName(targetExe)
  if (!exe) return true
  return apps.includes(exe)
}

/**
 * Centralized global shortcut lifecycle manager (global actions + phrase hotkeys).
 *
 * @param {{
 *   globalShortcut: { register: (acc: string, cb: () => void) => boolean, unregisterAll: () => void },
 *   getSettings: () => any,
 *   getLibrary?: () => any,
 *   getTargetExe?: () => string | null,
 *   isSuspended: () => boolean,
 *   onTogglePanel: () => void,
 *   onFocusSearch: () => void,
 *   onAssist: () => void,
 *   onTriggerPhrase?: (phraseId: string) => void,
 *   onFailuresChanged?: (failures: Array<{ hotkey: string, reason: string }>) => void,
 * }} deps
 */
function createHotkeyManager(deps) {
  /** @type {Array<{ hotkey: string, reason: string }>} */
  let failures = []
  let lastTargetExe = null
  let hasAppScopedHotkeys = false

  function cloneFailures(list = failures) {
    return list.map((item) => ({ hotkey: item.hotkey, reason: item.reason }))
  }

  function unregisterAllSafe() {
    try { deps.globalShortcut.unregisterAll() } catch { /* ignore */ }
  }

  function tryRegisterEntry(raw, label, handler, claimed, nextFailures, shouldRegisterOs = true) {
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (!trimmed) return
    const acc = acceleratorFromSetting(trimmed)
    if (!acc) return
    const key = normalizeAcceleratorKey(acc)
    if (claimed.has(key)) {
      const owner = claimed.get(key)
      const ownerText = owner.startsWith('话术「') ? owner : `「${owner}」`
      nextFailures.push({ hotkey: trimmed, reason: `与${ownerText}的热键冲突` })
      return
    }
    if (!shouldRegisterOs) {
      claimed.set(key, label)
      return
    }
    try {
      const ok = deps.globalShortcut.register(acc, handler)
      if (ok === false) {
        nextFailures.push({ hotkey: trimmed, reason: '已被其他软件占用' })
      } else {
        claimed.set(key, label)
      }
    } catch (e) {
      console.warn('[hotkey] register failed', trimmed, e)
      nextFailures.push({ hotkey: trimmed, reason: '快捷键格式无效或系统不支持' })
    }
  }

  function sync() {
    unregisterAllSafe()
    const targetExe = normalizeExeName(deps.getTargetExe?.())
    lastTargetExe = targetExe

    if (deps.isSuspended?.()) {
      return cloneFailures()
    }

    const settings = deps.getSettings?.() || {}
    const hotkeys = settings.hotkeys || {}
    const nextFailures = []
    const claimed = new Map()

    const globalEntries = [
      { raw: hotkeys.togglePanel, label: '呼出/隐藏面板', handler: deps.onTogglePanel },
      { raw: hotkeys.focusSearch, label: '进入搜索', handler: deps.onFocusSearch },
      { raw: hotkeys.assist, label: '问 AI', handler: deps.onAssist },
    ]
    for (const entry of globalEntries) {
      tryRegisterEntry(entry.raw, entry.label, entry.handler, claimed, nextFailures, true)
    }

    const library = deps.getLibrary?.()
    hasAppScopedHotkeys = false
    for (const group of library?.groups || []) {
      const groupApps = extractGroupApps(group)
      const groupActive = isGroupApplicableToExe(group, targetExe)
      for (const phrase of group?.phrases || []) {
        const raw = typeof phrase?.hotkey === 'string' ? phrase.hotkey.trim() : ''
        if (!raw || !isPhraseSendable(phrase)) continue
        if (groupApps.length > 0) hasAppScopedHotkeys = true
        const title = String(phrase.title || phrase.content || '未命名话术').trim().slice(0, 24) || '未命名话术'
        const phraseId = phrase.id
        tryRegisterEntry(
          raw,
          `话术「${title}」`,
          () => deps.onTriggerPhrase?.(phraseId),
          claimed,
          nextFailures,
          groupActive,
        )
      }
    }

    failures = nextFailures
    deps.onFailuresChanged?.(cloneFailures(failures))
    return cloneFailures(failures)
  }

  function syncForTargetExe(exe) {
    const nextExe = normalizeExeName(exe)
    if (nextExe === lastTargetExe) {
      return cloneFailures(failures)
    }
    lastTargetExe = nextExe
    if (!hasAppScopedHotkeys) {
      return cloneFailures(failures)
    }
    return sync()
  }

  return {
    sync,
    syncForTargetExe,
    getFailures: () => cloneFailures(failures),
  }
}

module.exports = {
  acceleratorFromSetting,
  isPhraseSendable,
  isGroupApplicableToExe,
  createHotkeyManager,
}
