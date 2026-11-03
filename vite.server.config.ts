import { defineConfig } from 'vite'

// SSR build of the backend: one ESM file whose only imports are node:* built-ins (our own src/ code is bundled in), plus the
// Claude Agent SDK. The SDK stays outside the bundle on purpose: it finds its bundled Claude Code binary relative to its own
// files in node_modules, so `npm run server:start` needs node_modules (the SDK and its platform package) next to dist-server.
export default defineConfig({
  publicDir: false,
  ssr: { target: 'node', noExternal: true, external: ['@anthropic-ai/claude-agent-sdk'] },
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: { external: ['@anthropic-ai/claude-agent-sdk'], output: { format: 'es', entryFileNames: 'index.js' } },
  },
})
