import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Counts the browser pages connected to the dev server and calls onEmpty the moment the last one goes away.
 * Nothing fires before the first page has connected, so a freshly started server isn't stopped while the browser opens.
 */
export function createClientTracker(onEmpty: () => void) {
  let open = 0
  return {
    connected() {
      open++
    },
    disconnected() {
      if (open === 0) return
      open--
      if (open === 0) onEmpty()
    },
  }
}

/**
 * Dev-server plugin for `/vo`: when `enabled` (scripts/vo.sh sets VO_AUTO_EXIT=1), closing the last app page stops the
 * server immediately and removes its pid file. A reload also closes the page's connection, so it stops the server too.
 */
export function voAutoExit(enabled: boolean): Plugin {
  return {
    name: 'vo-auto-exit',
    apply: 'serve',
    configureServer(server) {
      if (!enabled) return
      const pidFile = join(server.config.root, '.vo-server.pid')
      const tracker = createClientTracker(() => {
        rmSync(pidFile, { force: true })
        process.exit(0)
      })
      server.ws.on('connection', (socket) => {
        tracker.connected()
        socket.on('close', () => tracker.disconnected())
      })
    },
  }
}
