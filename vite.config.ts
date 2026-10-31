/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { apiProxyFor } from './scripts/apiProxy'
import { voAutoExit } from './scripts/voAutoExit'

export default defineConfig(({ mode }) => {
  // Backend mode with the dev proxy: VITE_WORKFORCE_API_URL=/ (dev:full sets it). Otherwise nothing is proxied.
  const api = apiProxyFor(loadEnv(mode, process.cwd(), ''))
  return {
    plugins: [react(), voAutoExit(process.env.VO_AUTO_EXIT === '1'), ...(api ? [api.plugin] : [])],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      ...(api ? { proxy: api.proxy } : {}),
    },
    // Let tests read stylesheets as text (Vitest replaces CSS with an empty string by default).
    // No persistent module cache: it keys on a file's own text, so import.meta.glob lists in the source-scanning tests went stale when files were added.
    test: { css: true, fsModuleCache: false },
  }
})
