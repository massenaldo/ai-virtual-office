import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE, type AuditRecord } from './audit'
import { parseConfig } from './config'
import { officeClockInfo, parseDevClock } from './officeClock'
import { startTestServer, type TestServer } from './test/helpers'

const START = Date.parse('2031-03-04T11:40:00+07:00')

describe('parseDevClock', () => {
  it('is null when unset', () => {
    expect(parseDevClock(undefined)).toBeNull()
  })

  it('reads a start time with its timezone offset and a speed', () => {
    expect(parseDevClock('2031-03-04T11:40:00+07:00@60')).toEqual({ startMs: START, speed: 60 })
    // The same instant written in another zone is the same start.
    expect(parseDevClock('2031-03-04T04:40:00Z@60')).toEqual({ startMs: START, speed: 60 })
    expect(parseDevClock('2031-03-04T00:40:00-04:00@1')).toEqual({ startMs: START, speed: 1 })
    expect(parseDevClock('2031-03-04T11:40:00+07:00@3600')).toEqual({ startMs: START, speed: 3600 })
    expect(parseDevClock('2031-03-04T11:40:00+07:00@0.5')).toBe('invalid')
  })

  it.each([
    '', 'x', '@60', '2031-03-04T11:40:00+07:00', '2031-03-04T11:40:00+07:00@', '2031-03-04T11:40:00+07:00@0', '2031-03-04T11:40:00+07:00@3601',
    '2031-03-04T11:40:00+07:00@-5', '2031-03-04T11:40:00+07:00@abc', '2031-03-04T11:40:00+07:00@Infinity', '2031-03-04T11:40:00+07:00@1e3',
    '2031-03-04T11:40:00@60', '2031-03-04@60', '2031-13-40T11:40:00+07:00@60', 'not a date@60', '2031-03-04T25:00:00+07:00@60',
  ])('rejects %j', (raw) => {
    expect(parseDevClock(raw)).toBe('invalid')
  })
})

describe('officeClockInfo', () => {
  it('is real time at speed 1 without a dev clock, and reports the routine setting', () => {
    expect(officeClockInfo({ devClock: null, officeRoutine: true }, () => 1234, 0)).toEqual({ nowMs: 1234, speed: 1, routine: true })
    expect(officeClockInfo({ devClock: null, officeRoutine: false }, () => 1234, 0).routine).toBe(false)
  })

  it('runs from the start time at the given speed, computed from the time it is asked', () => {
    const config = { devClock: { startMs: START, speed: 60 }, officeRoutine: true }
    expect(officeClockInfo(config, () => 1000, 1000).nowMs).toBe(START)
    expect(officeClockInfo(config, () => 3000, 1000)).toEqual({ nowMs: START + 120000, speed: 60, routine: true })
  })
})

describe('the dev clock changes no real time', () => {
  let s: TestServer | null = null
  afterEach(async () => { await s?.close(); s = null })

  it('task, agent and audit timestamps stay real while /api/state reports the dev clock', async () => {
    const before = Date.now()
    s = await startTestServer({ VO_DEV_CLOCK: '2031-03-04T11:40:00+07:00@60' }, { mockTimings: { thinkingMs: 5, workingMs: 5 } })
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', description: 'REST' })
    expect(started.status).toBe(202)
    const end = Date.now() + 20000
    let body = (await s.api('GET', '/api/state')).body
    while (body.state.tasks[0]?.status !== 'completed') {
      if (Date.now() > end) throw new Error('task did not finish in time')
      await new Promise((r) => setTimeout(r, 10))
      body = (await s.api('GET', '/api/state')).body
    }
    const after = Date.now()
    // Generous bounds for a slow machine; the dev clock is years away from these.
    const real = (iso: string | null) => { expect(iso).not.toBeNull(); const t = Date.parse(iso!); expect(t).toBeGreaterThanOrEqual(before - 60000); expect(t).toBeLessThanOrEqual(after + 60000) }
    const task = body.state.tasks[0]
    real(task.createdAt)
    real(task.startedAt)
    real(task.completedAt)
    for (const a of body.state.agents) real(a.createdAt)
    const audit = readFileSync(join(s.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditRecord)
    expect(audit.length).toBeGreaterThan(0)
    for (const r of audit) real(r.at)
    // And the office clock is the dev one.
    expect(body.office.speed).toBe(60)
    expect(body.office.nowMs).toBeGreaterThanOrEqual(START)
    expect(body.office.nowMs).toBeLessThan(START + 3600000)
  })
})

describe('VO_DEV_CLOCK and Claude', () => {
  it('is refused with RUNTIME=claude and with ENABLE_CLAUDE_RUNTIME=yes, and fine with the mock', () => {
    const clock = '2031-03-04T11:40:00+07:00@60'
    for (const env of [{ RUNTIME: 'claude' }, { ENABLE_CLAUDE_RUNTIME: 'yes' }, { RUNTIME: 'claude', ENABLE_CLAUDE_RUNTIME: 'yes' }]) {
      const r = parseConfig({ VO_DEV_CLOCK: clock, ...env }, '/repo')
      expect(r.ok).toBe(false)
      expect(!r.ok && r.errors.join(' ')).toContain('VO_DEV_CLOCK')
    }
    const ok = parseConfig({ VO_DEV_CLOCK: clock }, '/repo')
    expect(ok.ok && ok.config.devClock).toEqual({ startMs: START, speed: 60 })
  })
})
