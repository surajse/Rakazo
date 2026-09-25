import './style.css'
import { renderQuick } from './views/quick'
import { renderSetup } from './views/setup'
import { renderSettings } from './views/settings'

const app = document.getElementById('app')!
let dispose: (() => void) | null = null

function route(): void {
  dispose?.()
  dispose = null
  app.innerHTML = ''
  const hash = (location.hash || '#/quick').replace(/^#\/?/, '')
  if (hash.startsWith('settings')) dispose = renderSettings(app)
  else if (hash.startsWith('setup')) dispose = renderSetup(app)
  else dispose = renderQuick(app) // default: quick chat popup
}

window.addEventListener('hashchange', route)
route()
