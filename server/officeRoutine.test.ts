import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { jakartaDay } from '../src/office/jakartaClock'
import { daySchedule } from '../src/office/schedule'
import { FakeProvider } from './test/fakeProvider'
import { startTestServer, type TestServer } from './test/helpers'

let s: TestServer | null = null
afterEach(async () => {
  await s?.close()
  s = null
})

// The spec's first anti-goal: presence, routine, walking and chat must never create a Claude call, cost or session.
describe('the office routine never reaches a runtime', () => {
  it('a server with a provider and agents, whose state is read repeatedly, never starts one', async () => {
    const provider = new FakeProvider()
    s = await startTestServer({ OFFICE_ROUTINE: 'on' }, { provider })
    for (let i = 0; i < 25; i++) {
      const state = await s.api('GET', '/api/state')
      expect(state.status).toBe(200)
      expect(state.body.office.routine).toBe(true)
      await new Promise((r) => setTimeout(r, 5))
    }
    expect((await s.api('GET', '/api/state')).body.state.agents.length).toBeGreaterThan(0)
    expect(provider.starts).toEqual([])
  })

  it('a task given during a hold with a provider registered never reaches it until release', async () => {
    const provider = new FakeProvider()
    const day = jakartaDay(Date.parse('2026-11-09T12:00:00+07:00'))
    const lunch = daySchedule({ id: 'agent-demo-backend', takesPrayerBreaks: true }, day).find((e) => e.kind === 'lunch')!
    let office = lunch.startMs + 60000
    s = await startTestServer({ OFFICE_ROUTINE: 'on' }, { provider, officeNow: () => office })
    const r = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'T', description: '' })
    expect(r.body.task.status).toBe('queued')
    await new Promise((res) => setTimeout(res, 50))
    s.app.manager.releaseHeldTasks()
    expect(provider.starts).toEqual([])
    office = lunch.endMs
    s.app.manager.releaseHeldTasks()
    await new Promise((res) => setTimeout(res, 10))
    expect(provider.starts).toHaveLength(1)
  })

  it('the routine code has no way to reach one: pure, with no network, server or runtime imports', () => {
    const dir = join(__dirname, '..', 'src', 'office')
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(5)
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8')
      expect([file, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|@anthropic|claude-agent-sdk/.test(text)]).toEqual([file, false])
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      expect([file, imports.filter((i) => /server|runtime|workforce|scene|^three$|^react$/.test(i))]).toEqual([file, []])
    }
  })
})
