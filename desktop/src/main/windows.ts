import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { getConfig } from './store'
import { probeWeb } from './api'

let mainWindow: BrowserWindow | null = null
let quickWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

/** Load a local renderer route (#/quick, #/setup, #/settings). */
function loadRoute(win: BrowserWindow, route: string): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${route}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  }
}

function baseWindow(opts: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...opts,
    webPreferences: {
      // electron-vite emits the preload bundle as .mjs
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox must stay off: a sandboxed renderer cannot load an ESM (.mjs)
      // preload bundle ("Cannot use import statement outside a module").
      // This matches the official electron-vite template; the security
      // boundary is contextIsolation + no nodeIntegration + the typed bridge.
      sandbox: false
    }
  })
  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  return win
}

/**
 * Main shell window. Loads the Rakazo web app; if it is unreachable,
 * falls back to the local setup screen with instructions to start
 * the backend + web app.
 */
export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const cfg = getConfig()
  mainWindow = baseWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: !cfg.startMinimized,
    title: 'Rakazo',
    backgroundColor: '#FDFDFD',
    autoHideMenuBar: true
  })

  const tryWebApp = async (): Promise<void> => {
    const webUrl = getConfig().webUrl.replace(/\/+$/, '')
    if (await probeWeb(webUrl)) {
      await mainWindow!.loadURL(webUrl).catch(() => loadRoute(mainWindow!, 'setup'))
    } else {
      loadRoute(mainWindow!, 'setup')
    }
  }
  // If the web app goes down while open, show the setup screen again.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (!url.startsWith('file:')) loadRoute(mainWindow!, 'setup')
  })
  void tryWebApp()

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

export function openMainWindow(): void {
  const win = createMainWindow()
  if (!win.isVisible()) win.show()
  win.focus()
}

/**
 * Compact quick-chat popup summoned from the tray / hotkey.
 * Frameless, small, optionally always-on-top.
 */
export function createQuickWindow(): BrowserWindow {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow
  const cfg = getConfig()
  quickWindow = baseWindow({
    width: 400,
    height: 600,
    minWidth: 340,
    minHeight: 480,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: cfg.alwaysOnTop,
    skipTaskbar: true,
    title: 'Rakazo Quick Chat',
    backgroundColor: '#FDFDFD',
    // Keep it out of screenshots / screen sharing? No — keep visible.
    hiddenInMissionControl: false
  })
  loadRoute(quickWindow, 'quick')
  quickWindow.on('closed', () => {
    quickWindow = null
  })
  // Hide instead of closing so state is preserved.
  quickWindow.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault()
      quickWindow?.hide()
    }
  })
  return quickWindow
}

let appQuitting = false
export function setAppQuitting(): void {
  appQuitting = true
}

export function toggleQuickChat(trayBounds?: Electron.Rectangle): void {
  const win = createQuickWindow()
  if (win.isVisible()) {
    win.hide()
    return
  }
  if (trayBounds) {
    const [w, h] = win.getSize()
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    const area = display.workArea
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - w / 2)
    // macOS tray is at the top; Windows/Linux taskbars are usually at the bottom.
    const y =
      process.platform === 'darwin'
        ? Math.round(trayBounds.y + trayBounds.height + 12)
        : Math.round(trayBounds.y - h - 12)
    x = Math.max(area.x + 8, Math.min(x, area.x + area.width - w - 8))
    win.setPosition(x, Math.max(area.y + 8, y))
  } else {
    win.center()
  }
  win.show()
  win.focus()
}

/** Show quick chat with a specific bot selected (deep links, notifications). */
export function focusQuickChatWithBot(botId: string): void {
  const win = createQuickWindow()
  if (!win.isVisible()) {
    win.center()
    win.show()
  }
  win.focus()
  win.webContents.send('rakazo:open-bot', botId)
}

export function getQuickWindow(): BrowserWindow | null {
  return quickWindow && !quickWindow.isDestroyed() ? quickWindow : null
}

export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = baseWindow({
    width: 500,
    height: 660,
    minWidth: 440,
    minHeight: 560,
    show: true,
    title: 'Rakazo Settings',
    backgroundColor: '#FDFDFD',
    autoHideMenuBar: true
  })
  loadRoute(settingsWindow, 'settings')
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}
