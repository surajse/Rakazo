import type { RakazoBridge } from '../shared/bridge'

declare global {
  interface Window {
    rakazo: RakazoBridge
  }
}

export {}
