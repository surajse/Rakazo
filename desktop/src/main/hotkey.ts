import { globalShortcut } from 'electron'
import { toggleQuickChat } from './windows'

/** Summon quick chat from anywhere. */
export const HOTKEY = 'CommandOrControl+Shift+R'

export function registerHotkey(): void {
  const ok = globalShortcut.register(HOTKEY, () => toggleQuickChat())
  if (!ok) {
    console.warn(`[rakazo] Could not register global hotkey ${HOTKEY} — it may be taken by another app.`)
  }
}

export function unregisterHotkey(): void {
  globalShortcut.unregisterAll()
}
