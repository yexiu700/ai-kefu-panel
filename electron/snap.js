'use strict'
/**
 * Panel dock/follow: when settings.panel.docked, keep the panel stuck to the target window.
 * Also auto-bind foreground chat apps when settings.panel.autoBind and target is not pinned.
 */
const store = require('./store')
const win32 = require('./win32')
const { pollPolicy } = require('./snap-policy')
const { normalizeExeName } = require('../frontend/panel/send-rule')

function matchesChatApp(exe, chatApps) {
  const e = normalizeExeName(exe)
  if (!e) return false
  const list = Array.isArray(chatApps) ? chatApps : []
  return list.some((item) => {
    const n = normalizeExeName(item)
    return Boolean(n) && e === n
  })
}

function isOurWindow(winOrTitle, selfPid = (typeof process !== 'undefined' ? process.pid : 0)) {
  if (winOrTitle && typeof winOrTitle === 'object') {
    const pid = Number(winOrTitle.pid || 0)
    if (pid > 0 && selfPid > 0) return pid === selfPid
    const t = String(winOrTitle.title || '')
    return t.includes('AI客服') || t.includes('ai-kefu-panel')
  }
  const t = String(winOrTitle || '')
  return t.includes('AI客服') || t.includes('ai-kefu-panel')
}

function isUsableWindowRect(info) {
  if (!info || info.visible === false || info.iconic === true) return false
  const left = Number(info.left)
  const top = Number(info.top)
  const width = Number(info.width)
  const height = Number(info.height)
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) return false
  if (width <= 0 || height <= 0) return false
  // Windows reports (-32000, -32000) for minimized windows even when IsWindowVisible is true.
  if (left <= -30000 || top <= -30000) return false
  return true
}

function computeSnap(rect, panelW, panelH, side, gap = 0, workArea = null) {
  const g = Math.max(0, gap | 0)
  let x = side === 'left' ? rect.left - panelW - g : rect.right + g
  let y = rect.top
  if (panelH < rect.height) {
    y = rect.top + Math.floor((rect.height - panelH) / 2)
  }
  if (workArea && Number.isFinite(workArea.x) && Number.isFinite(workArea.y) && workArea.width > 0 && workArea.height > 0) {
    const maxX = workArea.x + Math.max(0, workArea.width - panelW)
    const maxY = workArea.y + Math.max(0, workArea.height - panelH)
    x = Math.max(workArea.x, Math.min(maxX, x))
    y = Math.max(workArea.y, Math.min(maxY, y))
  }
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * @param {{
 *   getPanelWindow: () => import('electron').BrowserWindow | null,
 *   getRuntime: () => any,
 *   setTarget: (t: any, opts?: { emit?: boolean }) => void,
 *   emitTarget: (t: any) => void,
 *   getWorkArea?: (rect: { left: number, top: number, width: number, height: number }) => ({ x: number, y: number, width: number, height: number } | null),
 * }} deps
 */
function startSnapLoop(deps) {
  let timer = null
  let lastSnapKey = ''
  let busy = false
  let lastForegroundPoll = -Infinity

  async function tick() {
    if (busy) return
    busy = true
    try {
      if (!win32.isWin()) return
      const settings = store.loadSettings()
      const runtime = deps.getRuntime()
      const panel = deps.getPanelWindow?.()
      const docked = !!settings.panel?.docked
      const autoBind = settings.panel?.autoBind !== false
      const visible = runtime.panelVisible !== false && !!panel && !panel.isDestroyed() && panel.isVisible()
      const policy = pollPolicy({ docked, visible, autoBind, pinned: runtime.pinned,
        now: Date.now(), lastForegroundPoll })
      const side = settings.panel?.side === 'left' ? 'left' : 'right'
      const chatApps = settings.panel?.chatApps || []

      let target = runtime.target
      let targetMinimized = false

      // Refresh / auto-bind
      if ((runtime.pinned || !autoBind) && target?.hwnd && policy.shouldRefreshRect) {
        const info = await win32.getWindowRect(target.hwnd)
        if (isUsableWindowRect(info)) {
          const next = {
            hwnd: Number(info.hwnd),
            title: info.title || target.title || '',
            exe: info.exe || target.exe || '',
            bound: true,
            rect: {
              left: info.left, top: info.top, right: info.right, bottom: info.bottom,
              width: info.width, height: info.height,
            },
          }
          const changed =
            !target.rect ||
            target.title !== next.title ||
            target.rect.left !== next.rect.left ||
            target.rect.top !== next.rect.top ||
            target.rect.width !== next.rect.width ||
            target.rect.height !== next.rect.height
          deps.setTarget(next, { emit: changed })
          target = next
        } else if (info && (info.iconic === true || info.visible === false || info.left <= -30000 || info.top <= -30000)) {
          targetMinimized = true
        }
      } else if (policy.shouldPollForeground) {
        lastForegroundPoll = Date.now()
        const fg = await win32.getForeground()
        if (fg && !isOurWindow(fg) && matchesChatApp(fg.exe, chatApps)) {
          const usable = isUsableWindowRect(fg)
          const next = {
            hwnd: Number(fg.hwnd),
            title: fg.title || '',
            exe: fg.exe || '',
            bound: false,
            rect: usable
              ? {
                left: fg.left, top: fg.top, right: fg.right, bottom: fg.bottom,
                width: fg.width, height: fg.height,
              }
              : target?.rect || null,
          }
          const prev = runtime.target
          const changed =
            !prev ||
            prev.hwnd !== next.hwnd ||
            prev.title !== next.title ||
            (usable && (!prev.rect ||
              prev.rect.left !== next.rect.left ||
              prev.rect.top !== next.rect.top ||
              prev.rect.width !== next.rect.width ||
              prev.rect.height !== next.rect.height))
          deps.setTarget(next, { emit: changed })
          target = next
          if (!usable) targetMinimized = true
        } else if (target?.hwnd && !runtime.pinned && policy.shouldRefreshRect) {
          // keep last known rect fresh if still valid
          const info = await win32.getWindowRect(target.hwnd)
          if (isUsableWindowRect(info)) {
            target = {
              ...target,
              title: info.title || target.title,
              exe: info.exe || target.exe,
              rect: {
                left: info.left, top: info.top, right: info.right, bottom: info.bottom,
                width: info.width, height: info.height,
              },
            }
            deps.setTarget(target, { emit: false })
          } else if (info && (info.iconic === true || info.visible === false || info.left <= -30000 || info.top <= -30000)) {
            targetMinimized = true
          }
        }
      }

      // Snap follow
      if (policy.shouldSnap && !targetMinimized && target?.rect && isUsableWindowRect(target.rect)) {
        const [pw, ph] = panel.getSize()
        const workArea = deps.getWorkArea?.(target.rect) || null
        const { x, y } = computeSnap(target.rect, pw, ph, side, 0, workArea)
        const key = `${x},${y},${pw},${ph},${side},${target.hwnd}`
        if (key !== lastSnapKey) {
          // Avoid fighting user drag when not docked — we only move when docked.
          try {
            panel.setPosition(x, y, false)
            lastSnapKey = key
          } catch (e) {
            console.warn('[snap] setPosition', e)
          }
        }
      } else {
        lastSnapKey = ''
      }
    } catch (e) {
      console.warn('[snap] tick', e)
    } finally {
      busy = false
    }
  }

  timer = setInterval(tick, 280)
  // kick once after daemon warm-up
  const warmup = setTimeout(tick, 600)

  return () => {
    if (timer) clearInterval(timer)
    clearTimeout(warmup)
    timer = null
  }
}

module.exports = { startSnapLoop, computeSnap, matchesChatApp, isOurWindow, isUsableWindowRect }
