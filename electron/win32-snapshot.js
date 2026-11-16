'use strict'
// Read-only hot path. Sending, activation, clipboard and UIA stay in the daemon.
// Use the same DPI-unaware coordinate space as Windows PowerShell Get-WinInfo.
const path = require('node:path')

function createSnapshotBackend() {
  const koffi = require('koffi')
  const user = koffi.load('user32.dll')
  const kernel = koffi.load('kernel32.dll')
  const foreground = user.func('intptr_t __stdcall GetForegroundWindow()')
  const isWindow = user.func('int __stdcall IsWindow(intptr_t hwnd)')
  const isVisible = user.func('int __stdcall IsWindowVisible(intptr_t hwnd)')
  const isIconic = user.func('int __stdcall IsIconic(intptr_t hwnd)')
  const getRect = user.func('int __stdcall GetWindowRect(intptr_t hwnd, void *rect)')
  const textLength = user.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)')
  const getText = user.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *text, int count)')
  const getPid = user.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)')
  const setDpi = user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')
  const openProcess = kernel.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  const queryImage = kernel.func('int __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, void *name, void *size)')
  const closeHandle = kernel.func('int __stdcall CloseHandle(intptr_t handle)')

  function snapshot(hwnd) {
    hwnd = Number(hwnd)
    if (!hwnd || !isWindow(hwnd)) return null
    const rect = Buffer.alloc(16)
    const previousDpi = setDpi(-1)
    if (!previousDpi) throw new Error('Cannot match daemon DPI context')
    try { getRect(hwnd, rect) } finally { setDpi(previousDpi) }
    const count = Math.min(Math.max(textLength(hwnd) + 1, 1), 32768)
    const text = Buffer.alloc(count * 2)
    const length = getText(hwnd, text, count)
    const pidBuffer = Buffer.alloc(4)
    getPid(hwnd, pidBuffer)
    const pid = pidBuffer.readUInt32LE()
    let processName = ''
    const handle = openProcess(0x1000, 0, pid)
    if (handle) {
      try {
        const name = Buffer.alloc(32768 * 2)
        const size = Buffer.alloc(4)
        size.writeUInt32LE(32768)
        if (queryImage(handle, 0, name, size)) {
          processName = path.win32.basename(name.toString('utf16le', 0, size.readUInt32LE() * 2)).replace(/\.exe$/i, '')
        }
      } finally { closeHandle(handle) }
    }
    // PowerShell can sometimes read ProcessName when querying the image path is
    // denied. Let the bridge fall back rather than silently losing auto-bind.
    if (pid && !processName) throw new Error('Cannot read snapshot process name')
    const left = rect.readInt32LE(0), top = rect.readInt32LE(4)
    const right = rect.readInt32LE(8), bottom = rect.readInt32LE(12)
    return { hwnd, title: text.toString('utf16le', 0, Math.max(0, length) * 2),
      exe: processName ? `${processName}.exe` : '', processName, pid,
      left, top, right, bottom, width: right - left, height: bottom - top,
      visible: !!isVisible(hwnd), iconic: !!isIconic(hwnd) }
  }
  return { getForeground: () => snapshot(foreground()), getWindowRect: snapshot }
}

module.exports = { createSnapshotBackend }
