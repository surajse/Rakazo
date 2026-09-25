import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'

const DEFAULTS: AppConfig = {
  apiUrl: 'http://localhost:8000',
  webUrl: 'http://localhost:5173',
  autoLaunch: false,
  startMinimized: false,
  alwaysOnTop: false
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function tokenPath(): string {
  return join(app.getPath('userData'), 'token.bin')
}

export function getConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...getConfig(), ...patch }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * Auth token storage. Uses Electron's safeStorage (OS keychain:
 * Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux)
 * so the JWT is encrypted at rest. The plaintext token never leaves
 * the main process.
 */
export function saveToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available — cannot store the auth token securely.')
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(tokenPath(), safeStorage.encryptString(token))
}

export function loadToken(): string | null {
  try {
    if (!existsSync(tokenPath())) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(readFileSync(tokenPath()))
  } catch {
    return null
  }
}

export function clearToken(): void {
  try {
    if (existsSync(tokenPath())) unlinkSync(tokenPath())
  } catch {
    /* ignore */
  }
}

/** Path to a bundled asset (dev: project dir, prod: resources dir). */
export function assetPath(name: string): string {
  if (app.isPackaged) return join(process.resourcesPath, 'assets', name)
  return join(app.getAppPath(), 'assets', name)
}

/**
 * Auto-launch on login. Uses Electron's built-in login-item settings on
 * macOS/Windows; on Linux it manages a freedesktop .desktop autostart entry.
 */
export function applyAutoLaunch(enabled: boolean, hidden: boolean): void {
  if (process.platform === 'linux') {
    // Only manage autostart for packaged builds; in dev execPath is the
    // raw Electron binary, which would create a broken entry.
    if (!app.isPackaged) {
      console.warn('[rakazo] auto-launch is only applied in packaged builds on Linux')
      return
    }
    const dir = join(homedir(), '.config', 'autostart')
    const file = join(dir, 'rakazo-desktop.desktop')
    if (enabled) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Rakazo',
          `Exec=${process.execPath}${hidden ? ' --hidden' : ''}`,
          'X-GNOME-Autostart-enabled=true',
          ''
        ].join('\n'),
        'utf8'
      )
    } else {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
    return
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Squirrel.Windows (unsigned dev builds) handles this itself on Windows.
    ...(process.platform === 'win32' ? { path: process.execPath, args: hidden ? ['--hidden'] : [] } : {})
  })
}

export function isAutoLaunchEnabled(): boolean {
  if (process.platform === 'linux') {
    return existsSync(join(homedir(), '.config', 'autostart', 'rakazo-desktop.desktop'))
  }
  return app.getLoginItemSettings().openAtLogin
}
