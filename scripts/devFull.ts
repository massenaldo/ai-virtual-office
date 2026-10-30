import { createServer } from 'vite'
import { startServer } from '../server/app'
import { formatConfigErrors, loadConfig } from '../server/config'

// Backend and Vite dev server in one process, so no process-launching module and no extra dependency is needed.
const parsed = loadConfig()
if (!parsed.ok) {
  console.error(formatConfigErrors(parsed.errors))
  process.exit(1)
}

let backend
try {
  backend = await startServer(parsed.config)
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  console.error(code === 'EADDRINUSE' ? `Port ${parsed.config.port} is already in use (is the backend already running?).` : error instanceof Error ? error.message : String(error))
  process.exit(1)
}
console.log(`AI Virtual Office backend listening on ${backend.url} (runtime: ${parsed.config.runtime})`)
// The UI ignores this until Stage D connects it.
process.env.VITE_WORKFORCE_API_URL ??= backend.url

let vite: Awaited<ReturnType<typeof createServer>>
try {
  vite = await createServer({ configFile: 'vite.config.ts' })
  await vite.listen()
  vite.printUrls()
} catch (error) {
  await backend.close()
  console.error(`Port 5173 is in use (is npm run dev or /vo already running?). ${error instanceof Error ? error.message : ''}`.trim())
  process.exit(1)
}

const stop = () => { void Promise.all([vite.close(), backend.close()]).then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
