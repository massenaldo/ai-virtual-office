export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void }

export const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg, err) => (err === undefined ? console.error(msg) : console.error(msg, err)),
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
