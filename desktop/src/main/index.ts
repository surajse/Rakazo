import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { setupIpc } from './ipc'
import { createMainWindow, setAppQuitting, focusQuickChatWithBot } from './windows'
import { createTray, destroyTray } from './tray'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { startApprovalPolling, stopApprovalPolling } from './notifier'
import { applyAutoLaunch, getConfig } from './store'

// rakazo://bot/<id> — deep link into a specific bot.
const PROTOCOL = 'rakazo'

function handleDeepLinkUrl(url: string): void {
  try {
    const u = new URL(url)
    if (u.protocol !== `${PROTOCOL}:`) return
    // rakazo://bot/<id>
    const parts = u.pathname.split('/').filter(Boolean)
    if (u.host === 'bot' && parts[0]) {
      focusQuickChatWithBot(decodeURIComponent(parts[0]))
    }
  } catch {
    /* ignore malformed urls */
  }
}

function handleArgv(argv: string[]): void {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
  if (url) handleDeepLinkUrl(url)
}

// Single instance: second launches (e.g. via rakazo:// link) focus this one.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    handleArgv(argv)
  })

  // macOS deep links
  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleDeepLinkUrl(url)
  })

  if (process.defaultApp) {
    // electron-vite dev: register protocol against the dev argv
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.rakazo.desktop')
    app.on('browser-window-created', (_e, win) => optimizer.watchWindowShortcuts(win))

    setupIpc()
    createTray()
    registerHotkey()
    startApprovalPolling()

    // Re-apply auto-launch in case the binary moved (dev builds).
    const cfg = getConfig()
    if (cfg.autoLaunch) applyAutoLaunch(true, cfg.startMinimized)

    if (!cfg.startMinimized) {
      createMainWindow()
    }
    // Deep link that launched us (Windows/Linux).
    handleArgv(process.argv)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Keep running in the tray; quit explicitly via tray menu / Cmd+Q.
    if (process.platform !== 'darwin') {
      // On Windows/Linux the tray keeps us alive — do nothing.
    }
  })

  app.on('before-quit', () => {
    setAppQuitting()
    stopApprovalPolling()
    unregisterHotkey()
    destroyTray()
  })
}
