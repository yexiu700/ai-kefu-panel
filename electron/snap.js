'use strict'
/**
 * Panel dock/follow: when settings.panel.docked, keep the panel stuck to the target window.
 * Also auto-bind foreground chat apps when settings.panel.autoBind and target is not pinned.
 */
const store = require('./store')
const win32 = require('./win32')

function normalizeExe(exe) {
  return String(exe || '').trim().toLowerCase().replace(/\.exe$/i, '')
}

function matchesChatApp(exe, chatApps) {
  const e = normalizeExe(exe)
  if (!e) return false
  const list = Array.isArray(chatApps) ? chatApps : []
  return list.some((item) => {
    const n = normalizeExe(item)
    return n && (e === n || e.includes(n) || n.includes(e))
  })
}

function isOurWindow(title) {
  const t = String(title || '')
  return t.includes('AI客服') || t.includes('huiyou-original-shell')
}

function computeSnap(rect, panelW, panelH, side, gap = 0) {
  const g = Math.max(0, gap | 0)
  const x = side === 'left' ? rect.left - panelW - g : rect.right + g
  let y = rect.top
  if (panelH < rect.height) {
    y = rect.top + Math.floor((rect.height - panelH) / 2)
  }
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * @param {{
 *   getPanelWindow: () => import('electron').BrowserWindow | null,
 *   getRuntime: () => any,
 *   setTarget: (t: any, opts?: { emit?: boolean }) => void,
 *   emitTarget: (t: any) => void,
 * }} deps
 */
function startSnapLoop(deps) {
  let timer = null
  let lastSnapKey = ''
  let busy = false

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
      const side = settings.panel?.side === 'left' ? 'left' : 'right'
      const chatApps = settings.panel?.chatApps || []

      let target = runtime.target

      // Refresh / auto-bind
      if (runtime.pinned && target?.hwnd) {
        const info = await win32.getWindowRect(target.hwnd)
        if (info && info.visible !== false) {
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
        }
      } else if (autoBind) {
        const fg = await win32.getForeground()
        if (fg && !isOurWindow(fg.title) && matchesChatApp(fg.exe, chatApps)) {
          const next = {
            hwnd: Number(fg.hwnd),
            title: fg.title || '',
            exe: fg.exe || '',
            bound: false,
            rect: {
              left: fg.left, top: fg.top, right: fg.right, bottom: fg.bottom,
              width: fg.width, height: fg.height,
            },
          }
          const prev = runtime.target
          const changed =
            !prev ||
            prev.hwnd !== next.hwnd ||
            prev.title !== next.title ||
            !prev.rect ||
            prev.rect.left !== next.rect.left ||
            prev.rect.top !== next.rect.top ||
            prev.rect.width !== next.rect.width ||
            prev.rect.height !== next.rect.height
          deps.setTarget(next, { emit: changed })
          target = next
        } else if (target?.hwnd && !runtime.pinned) {
          // keep last known rect fresh if still valid
          const info = await win32.getWindowRect(target.hwnd)
          if (info) {
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
          }
        }
      }

      // Snap follow
      if (docked && target?.rect && panel && !panel.isDestroyed() && runtime.panelVisible !== false) {
        const [pw, ph] = panel.getSize()
        const { x, y } = computeSnap(target.rect, pw, ph, side, 0)
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
  setTimeout(tick, 600)

  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}

module.exports = { startSnapLoop, computeSnap, matchesChatApp }
