/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { voAutoExit } from './scripts/voAutoExit'

export default defineConfig({
  plugins: [react(), voAutoExit(process.env.VO_AUTO_EXIT === '1')],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  // Let tests read stylesheets as text (Vitest replaces CSS with an empty string by default).
  // No persistent module cache: it keys on a file's own text, so import.meta.glob lists in the source-scanning tests went stale when files were added.
  test: { css: true, fsModuleCache: false },
})
