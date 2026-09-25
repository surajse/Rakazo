import { Menu, Tray, app, nativeImage } from 'electron'
import { assetPath } from './store'
import { openMainWindow, openSettingsWindow, toggleQuickChat } from './windows'
import { HOTKEY } from './hotkey'
import { pollApprovalsNow } from './notifier'

let tray: Tray | null = null

export function createTray(): void {
  if (tray) return
  // macOS: monochrome template image; elsewhere: full-color icon.
  const file = process.platform === 'darwin' ? 'tray@2x.png' : 'icon.png'
  const img = nativeImage.createFromPath(assetPath(file))
  if (process.platform === 'darwin') img.setTemplateImage(true)
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('Rakazo — your AI teammates')

  const menu = Menu.buildFromTemplate([
    { label: 'Open Rakazo', click: () => openMainWindow() },
    {
      label: 'Quick chat',
      accelerator: HOTKEY,
      click: (_item, _win, e) => toggleQuickChat()
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettingsWindow() },
    { label: 'Check approvals now', click: () => void pollApprovalsNow() },
    { type: 'separator' },
    {
      label: 'Quit Rakazo',
      click: () => app.quit()
    }
  ])
  tray.setContextMenu(menu)

  // Left-click toggles the quick-chat popup; right-click opens the menu.
  tray.on('click', (_e, bounds) => toggleQuickChat(bounds))
  tray.on('right-click', () => tray?.popUpContextMenu())
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
