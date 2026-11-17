'use strict'

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

/**
 * Centralized global shortcut lifecycle manager.
 *
 * @param {{
 *   globalShortcut: { register: (acc: string, cb: () => void) => boolean, unregisterAll: () => void },
 *   getSettings: () => any,
 *   isSuspended: () => boolean,
 *   onTogglePanel: () => void,
 *   onFocusSearch: () => void,
 *   onAssist: () => void,
 *   onFailuresChanged?: (failures: Array<{ hotkey: string, reason: string }>) => void,
 * }} deps
 */
function createHotkeyManager(deps) {
  /** @type {Array<{ hotkey: string, reason: string }>} */
  let failures = []

  function cloneFailures(list = failures) {
    return list.map((item) => ({ hotkey: item.hotkey, reason: item.reason }))
  }

  function unregisterAllSafe() {
    try { deps.globalShortcut.unregisterAll() } catch { /* ignore */ }
  }

  function sync() {
    unregisterAllSafe()
    if (deps.isSuspended?.()) {
      return cloneFailures()
    }

    const settings = deps.getSettings?.() || {}
    const hotkeys = settings.hotkeys || {}
    /** @type {Array<{ raw: string, label: string, handler: () => void }>} */
    const entries = [
      { raw: hotkeys.togglePanel, label: '呼出/隐藏面板', handler: deps.onTogglePanel },
      { raw: hotkeys.focusSearch, label: '进入搜索', handler: deps.onFocusSearch },
      { raw: hotkeys.assist, label: '问 AI', handler: deps.onAssist },
    ]

    const nextFailures = []
    const claimed = new Map()

    for (const entry of entries) {
      const raw = typeof entry.raw === 'string' ? entry.raw.trim() : ''
      if (!raw) continue
      const acc = acceleratorFromSetting(raw)
      if (!acc) continue
      const key = normalizeAcceleratorKey(acc)
      if (claimed.has(key)) {
        nextFailures.push({ hotkey: raw, reason: `与「${claimed.get(key)}」的热键冲突` })
        continue
      }
      try {
        const ok = deps.globalShortcut.register(acc, entry.handler)
        if (ok === false) {
          nextFailures.push({ hotkey: raw, reason: '已被其他软件占用' })
        } else {
          claimed.set(key, entry.label)
        }
      } catch (e) {
        console.warn('[hotkey] register failed', raw, e)
        nextFailures.push({ hotkey: raw, reason: '快捷键格式无效或系统不支持' })
      }
    }

    failures = nextFailures
    deps.onFailuresChanged?.(cloneFailures(failures))
    return cloneFailures(failures)
  }

  return {
    sync,
    getFailures: () => cloneFailures(failures),
  }
}

module.exports = {
  acceleratorFromSetting,
  createHotkeyManager,
}
