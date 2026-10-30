import { startServer } from './app'
import { formatConfigErrors, loadConfig } from './config'

const parsed = loadConfig()
if (!parsed.ok) {
  console.error(formatConfigErrors(parsed.errors))
  process.exit(1)
}

const running = await startServer(parsed.config)
console.log(`AI Virtual Office backend listening on ${running.url} (runtime: ${parsed.config.runtime})`)

const stop = () => { void running.close().then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
