import { parseEventId, type ChangeEvent, type PermissionChangeKind, type PermissionChangedEvent, type PermissionRuleView } from '../src/workforce/api'
import type { EventDraft } from './deriveEvents'
import { consoleLogger, type Logger } from './log'

/** Everything the log keeps and replays: workforce changes and permission changes share one id sequence. */
export type LoggedEvent = ChangeEvent | PermissionChangedEvent

export type EventLogOptions = { capacity: number; now: () => string; bootId?: string; log?: Logger }

/** Ids are '<bootId>:<seq>'; the boot part makes an id from before a restart recognisable, so it always triggers a reset. */
export class EventLog {
  readonly bootId: string
  private readonly capacity: number
  private readonly now: () => string
  private readonly log: Logger
  private readonly buffer: LoggedEvent[] = []
  private readonly listeners = new Set<(event: LoggedEvent) => void>()
  private seq = 0

  constructor({ capacity, now, bootId = Date.now().toString(36), log = consoleLogger }: EventLogOptions) {
    this.capacity = capacity
    this.now = now
    this.bootId = bootId
    this.log = log
  }

  get lastEventId(): string {
    return `${this.bootId}:${this.seq}`
  }

  /** Stamps id and time, keeps the newest `capacity` events, then tells every subscriber, in order. */
  append(drafts: EventDraft[]): ChangeEvent[] {
    const events = drafts.map((draft): ChangeEvent => ({ ...draft, id: `${this.bootId}:${++this.seq}`, at: this.now() }))
    this.publish(events)
    return events
  }

  /** A permission rule changed. It takes the next id like any other event, so a client replays both kinds in order. */
  appendPermission(kind: PermissionChangeKind, rule: PermissionRuleView): PermissionChangedEvent {
    const event: PermissionChangedEvent = { id: `${this.bootId}:${++this.seq}`, type: 'permission.changed', at: this.now(), kind, rule }
    this.publish([event])
    return event
  }

  private publish(events: LoggedEvent[]): void {
    for (const event of events) {
      this.buffer.push(event)
      if (this.buffer.length > this.capacity) this.buffer.shift()
    }
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch (error) {
          this.log.error('An event listener failed', error)
        }
      }
    }
  }

  /** The events a client missed, or a reset when its id can't be trusted (unparsable, another boot, ahead of us, or older than the buffer). */
  since(lastEventId: string | null): { kind: 'replay'; events: LoggedEvent[] } | { kind: 'reset' } {
    if (lastEventId === null) return { kind: 'replay', events: [] }
    const id = parseEventId(lastEventId)
    if (!id || id.boot !== this.bootId || id.seq > this.seq) return { kind: 'reset' }
    const oldest = this.buffer.length > 0 ? parseEventId(this.buffer[0].id)!.seq : this.seq + 1
    if (id.seq < oldest - 1) return { kind: 'reset' }
    return { kind: 'replay', events: this.buffer.filter((e) => parseEventId(e.id)!.seq > id.seq) }
  }

  subscribe(listener: (event: LoggedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  listenerCount(): number {
    return this.listeners.size
  }
}
