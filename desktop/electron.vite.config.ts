import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // safeStorage etc. are Electron builtins; keep native modules external
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // Vanilla TS renderer, no framework.
    // Port 5199: the Rakazo web app itself uses 5173 during development.
    server: { port: 5199, strictPort: true }
  }
})
