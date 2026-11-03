import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startServer } from '../server/app'
import { formatConfigErrors, loadConfig, mergeEnv } from '../server/config'
import { enforceHostSafety } from '../server/hostSafety'
import { startGateway } from '../server/gateway/gateway'
import { readPublicConfig } from '../server/gateway/publicConfig'
import { consoleLogger } from '../server/log'
import { redactingLogger } from '../server/redact'
import { tokenReader } from './apiProxy'

const log = redactingLogger(consoleLogger)

// The public entry: the backend stays on its own loopback address; only the gateway listens publicly.
const parsed = loadConfig()
if (!parsed.ok) {
  log.error(formatConfigErrors(parsed.errors))
  process.exit(1)
}
// The claude runtime shares one operating-system user with the server: refuse the worst setups, warn about the rest.
if (!enforceHostSafety(parsed.config, log)) process.exit(1)

// Same .env handling as loadConfig, so VO_PASSWORD and PUBLIC_* can live in .env too.
let envText: string | null = null
try {
  envText = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
const env = mergeEnv(envText, process.env)
const pub = readPublicConfig(env)
if (!pub.ok) {
  log.error(`Public gateway config is invalid:\n${pub.errors.map((e) => `- ${e}`).join('\n')}`)
  process.exit(1)
}

const staticDir = resolve(process.cwd(), 'dist')
if (!existsSync(resolve(staticDir, 'index.html'))) {
  log.error('The frontend is not built. Run npm run build:public first.')
  process.exit(1)
}

let backend
try {
  backend = await startServer(parsed.config)
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  log.error(code === 'EADDRINUSE' ? `Port ${parsed.config.port} is already in use (is the backend already running?).` : error instanceof Error ? error.message : String(error))
  process.exit(1)
}

let gateway
try {
  gateway = await startGateway({
    password: pub.password,
    staticDir,
    backend: { host: parsed.config.host, port: backend.port },
    readToken: tokenReader(env),
    host: pub.host,
    port: pub.port,
    log,
  })
} catch (error) {
  await backend.close()
  const code = (error as NodeJS.ErrnoException).code
  log.error(code === 'EADDRINUSE' ? `Port ${pub.port} is already in use.` : error instanceof Error ? error.message : String(error))
  process.exit(1)
}
log.info(`AI Virtual Office (runtime: ${parsed.config.runtime}) listening on ${pub.host}:${gateway.port}; open the HTTPS address InstaBox gives you for this port (any username, the password).`)
log.info(`The backend stays on ${backend.url} and is not reachable from outside.`)

const stop = () => { void Promise.all([gateway.close(), backend.close()]).then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
