import { defineConfig } from 'vite'

// SSR build of the backend: one ESM file whose only imports are node:* built-ins (our own src/ code is bundled in).
export default defineConfig({
  publicDir: false,
  ssr: { target: 'node', noExternal: true },
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.js' } },
  },
})
