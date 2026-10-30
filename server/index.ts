import { startServer } from './app'
import { formatConfigErrors, loadConfig } from './config'

const parsed = loadConfig()
if (!parsed.ok) {
  console.error(formatConfigErrors(parsed.errors))
  process.exit(1)
}

let running
try {
  running = await startServer(parsed.config)
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  console.error(code === 'EADDRINUSE' ? `Port ${parsed.config.port} is already in use (is the backend already running?).` : error instanceof Error ? error.message : String(error))
  process.exit(1)
}
console.log(`AI Virtual Office backend listening on ${running.url} (runtime: ${parsed.config.runtime})`)

const stop = () => { void running.close().then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
