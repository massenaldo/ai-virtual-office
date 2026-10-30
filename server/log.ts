export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void }

export const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg, err) => (err === undefined ? console.error(msg) : console.error(msg, err)),
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/** For tests: remembers every line as `<level> <message>[ <error>]`. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => { lines.push(`info ${msg}`) },
    warn: (msg) => { lines.push(`warn ${msg}`) },
    error: (msg, err) => { lines.push(`error ${msg}${err === undefined ? '' : ` ${String(err)}`}`) },
  }
}
