'use strict'
/**
 * Inject window.__TAURI_INTERNALS__ so the unpacked frontend boots unchanged.
 */
const { contextBridge, ipcRenderer } = require('electron')

const windowLabel = process.argv.find((a) => a.startsWith('--window-label='))?.slice('--window-label='.length)
  || new URLSearchParams(location.search).get('label')
  || 'panel'

const callbacks = new Map()
let nextCb = 1
const eventListeners = new Map() // event -> Map(id -> handlerCbId)

function runCallback(id, data) {
  const entry = callbacks.get(id)
  if (!entry) return
  try { entry.callback(data) } catch (e) { console.error('[tauri-cb]', e) }
  if (entry.once) callbacks.delete(id)
}

ipcRenderer.on('tauri-event', (_e, msg) => {
  const { event, payload } = msg || {}
  const map = eventListeners.get(event)
  if (!map) return
  for (const handlerId of map.values()) {
    runCallback(handlerId, { event, id: handlerId, payload })
  }
})

ipcRenderer.on('tauri-run-callback', (_e, msg) => {
  if (msg && typeof msg.id === 'number') runCallback(msg.id, msg.data)
})

async function invoke(cmd, args = {}, options) {
  // Handle event plugin locally so listen/emit works without main round-trip complexity
  if (cmd === 'plugin:event|listen') {
    const event = args.event
    const handlerId = args.handler
    if (!eventListeners.has(event)) eventListeners.set(event, new Map())
    const id = nextCb++
    eventListeners.get(event).set(id, handlerId)
    return id
  }
  if (cmd === 'plugin:event|unlisten') {
    const { event, eventId } = args
    eventListeners.get(event)?.delete(eventId)
    return null
  }
  if (cmd === 'plugin:event|emit') {
    ipcRenderer.send('tauri-emit', { event: args.event, payload: args.payload })
    return null
  }
  if (cmd === 'plugin:event|emit_to') {
    ipcRenderer.send('tauri-emit', { event: args.event, payload: args.payload, target: args.target })
    return null
  }

  // Window plugin: forward a useful subset, stub the rest
  if (typeof cmd === 'string' && cmd.startsWith('plugin:window|')) {
    const action = cmd.slice('plugin:window|'.length)
    if (action === 'get_all_windows') {
      return ipcRenderer.invoke('tauri-window', { action, args })
    }
    if ([
      'start_dragging', 'start_resize_dragging', 'set_size', 'set_position',
      'set_always_on_top', 'set_focus', 'show', 'hide', 'close', 'destroy',
      'outer_position', 'outer_size', 'inner_position', 'inner_size',
      'is_visible', 'is_focused', 'is_always_on_top', 'scale_factor',
      'set_ignore_cursor_events', 'set_title', 'center', 'minimize',
      'unminimize', 'maximize', 'unmaximize', 'title', 'theme',
    ].includes(action)) {
      return ipcRenderer.invoke('tauri-window', { action, args: { ...args, label: args.label || windowLabel } })
    }
    // Soft stub remaining window APIs
    console.debug('[window:stub]', action, args)
    if (action.startsWith('is_')) return false
    if (action === 'scale_factor') return 1
    if (action.endsWith('_size') || action.endsWith('_position')) return { width: 0, height: 0, x: 0, y: 0 }
    return null
  }

  if (typeof cmd === 'string' && cmd.startsWith('plugin:resources|')) {
    return null
  }
  if (typeof cmd === 'string' && cmd.startsWith('plugin:image|')) {
    console.debug('[image:stub]', cmd, args)
    return null
  }

  return ipcRenderer.invoke('tauri-invoke', { cmd, args: args || {}, options, windowLabel })
}

function transformCallback(callback, once = false) {
  const id = nextCb++
  callbacks.set(id, { callback, once: !!once })
  return id
}

function convertFileSrc(filePath, protocol = 'asset') {
  if (!filePath) return ''
  // Serve local files through custom media:// or file URL encoded for our HTTP static + query
  if (typeof filePath === 'string' && (filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith('data:'))) {
    return filePath
  }
  return `huiyou-media://localhost/?p=${encodeURIComponent(String(filePath))}`
}

const internals = {
  invoke,
  transformCallback,
  unregisterCallback(id) { callbacks.delete(id) },
  convertFileSrc,
  metadata: {
    currentWindow: { label: windowLabel },
    currentWebview: { label: windowLabel },
  },
}

// Must exist before module scripts run. With contextIsolation, expose via bridge + inject in isolated world isn't enough —
// the page world needs the object. Use a small execute trick: also set via contextBridge + preload without isolation for demo.
try {
  contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', internals)
  contextBridge.exposeInMainWorld('isTauri', true)
  contextBridge.exposeInMainWorld('__HUIYOU_SHELL__', { label: windowLabel, version: '0.2.18-shell' })
} catch (e) {
  // contextIsolation disabled fallback
  window.__TAURI_INTERNALS__ = internals
  window.isTauri = true
}

// Drag region CSS helper for Electron (Tauri uses data-tauri-drag-region)
window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style')
  style.textContent = `
    [data-tauri-drag-region], [data-tauri-drag-region="true"] {
      -webkit-app-region: drag;
    }
    [data-tauri-drag-region] button,
    [data-tauri-drag-region] input,
    [data-tauri-drag-region] a,
    [data-tauri-drag-region] select,
    [data-tauri-drag-region] textarea,
    button, input, a, select, textarea {
      -webkit-app-region: no-drag;
    }
  `
  document.documentElement.appendChild(style)
})
