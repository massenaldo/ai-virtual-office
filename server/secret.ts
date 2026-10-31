import { inspect } from 'node:util'

/** A value that must never be printed: every text form (String, JSON, inspect, template) gives [REDACTED]. Read it with reveal(). */
export class Secret {
  readonly #value: string
  constructor(value: string) { this.#value = value }
  reveal(): string { return this.#value }
  toString(): string { return '[REDACTED]' }
  toJSON(): string { return '[REDACTED]' }
  [inspect.custom](): string { return '[REDACTED]' }
}
