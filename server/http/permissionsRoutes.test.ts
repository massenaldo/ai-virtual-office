import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rawRequest, startTestServer, TEST_TOKEN, type TestServer } from '../test/helpers'

let s: TestServer
beforeEach(async () => { s = await startTestServer({}, { mockTimings: { thinkingMs: 60000, workingMs: 60000 } }) })
afterEach(async () => { await s.close() })

const FORGE = 'agent-demo-backend'
const list = async () => (await s.api('GET', '/api/permissions')).body.rules as Array<{ id: string; tool: string; scope: string; effect: string; state: string }>
const create = (body: unknown) => s.api('POST', '/api/permissions', body)

describe('GET /api/permissions', () => {
  it('lists the eight seeded defaults as active, with a state and no digest', async () => {
    const r = await s.api('GET', '/api/permissions')
    expect(r.status).toBe(200)
    expect(r.body.rules).toHaveLength(8)
    expect(r.body.rules.every((x: { state: string; createdBy: string }) => x.state === 'active' && x.createdBy === 'default')).toBe(true)
    expect(JSON.stringify(r.body)).not.toContain('digest')
    expect(r.body.rules.find((x: { id: string }) => x.id === 'default-write')).toMatchObject({ scope: 'global', effect: 'ask', tool: 'Write', agentId: null, pathPattern: null })
  })
})

describe('POST /api/permissions', () => {
  it('creates a global rule and an agent rule', async () => {
    const g = await create({ scope: 'global', effect: 'deny', tool: 'Grep', reason: 'no searching' })
    expect(g).toMatchObject({ status: 201, body: { rule: { scope: 'global', effect: 'deny', tool: 'Grep', createdBy: 'user', state: 'active', reason: 'no searching' } } })
    const a = await create({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: FORGE, pathPattern: 'src/**', expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    expect(a).toMatchObject({ status: 201, body: { rule: { scope: 'agent', agentId: FORGE, pathPattern: 'src/**', state: 'active' } } })
    expect((await list()).map((x) => x.id)).toEqual(expect.arrayContaining([g.body.rule.id, a.body.rule.id]))
  })

  it.each([
    ['an unknown key', { scope: 'global', effect: 'allow', tool: 'Read', digest: 'a'.repeat(64) }, 400, 'Unknown field "digest".'],
    ['task scope', { scope: 'task', effect: 'allow', tool: 'Write', agentId: FORGE }, 400, '"scope" must be "global" or "agent".'],
    ['once scope', { scope: 'once', effect: 'allow', tool: 'Write', agentId: FORGE }, 400, '"scope" must be "global" or "agent".'],
    ['a non-string tool', { scope: 'global', effect: 'allow', tool: 7 }, 400, '"tool" must be a string.'],
    ['an unknown tool', { scope: 'global', effect: 'allow', tool: 'Nope' }, 422, 'Unknown tool.'],
    ['an unknown effect', { scope: 'global', effect: 'maybe', tool: 'Read' }, 422, '"effect" must be "allow", "deny" or "ask".'],
    ['an agent rule without an agent', { scope: 'agent', effect: 'allow', tool: 'Write' }, 422, '"agentId" is required for an agent rule.'],
    ['a global rule with an agent', { scope: 'global', effect: 'allow', tool: 'Read', agentId: FORGE }, 422, '"agentId" is only for an agent rule.'],
    ['an unknown agent', { scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'agent-nope' }, 404, 'Agent not found.'],
    ['a bad pattern', { scope: 'global', effect: 'deny', tool: 'Write', pathPattern: '../etc' }, 422, '"pathPattern" must be a workspace-relative pattern such as src/**.'],
    ['a past expiry', { scope: 'global', effect: 'deny', tool: 'Write', expiresAt: '2020-01-01T00:00:00.000Z' }, 422, '"expiresAt" must be a date in the future.'],
    ['a long reason', { scope: 'global', effect: 'deny', tool: 'Write', reason: 'x'.repeat(201) }, 422, '"reason" is too long (200 characters at most).'],
    ['an execute tool allowed for an agent', { scope: 'agent', effect: 'allow', tool: 'Bash', agentId: FORGE }, 422, 'That tool can only be allowed once, so it cannot be allowed for an agent or everyone.'],
    ['a network tool allowed globally', { scope: 'global', effect: 'allow', tool: 'WebFetch' }, 422, 'That tool can only be allowed once, so it cannot be allowed for an agent or everyone.'],
  ])('refuses %s', async (_name, body, status, error) => {
    expect(await create(body)).toMatchObject({ status, body: { error } })
    expect(await list()).toHaveLength(8)
  })

  it('still lets Bash be denied or asked about', async () => {
    expect((await create({ scope: 'agent', effect: 'deny', tool: 'Bash', agentId: FORGE })).status).toBe(201)
    expect((await create({ scope: 'global', effect: 'ask', tool: 'WebFetch' })).status).toBe(201)
  })

  it('answers 409 when there are too many active rules', async () => {
    const small = await startTestServer({}, { mockTimings: { thinkingMs: 60000, workingMs: 60000 } })
    try {
      // Fill to the limit through the store the server is using.
      let last = { ok: true as boolean }
      for (let i = 0; i < 600 && last.ok; i++) last = small.app.permissions.grant({ scope: 'agent', effect: 'deny', tool: 'Grep', agentId: FORGE, reason: `r${i}` })
      expect(await small.api('POST', '/api/permissions', { scope: 'global', effect: 'deny', tool: 'Glob' })).toMatchObject({ status: 409, body: { error: 'Too many active permissions.' } })
    } finally { await small.close() }
  })

  it('needs the token and a JSON content type', async () => {
    expect((await rawRequest(s.url, { method: 'POST', path: '/api/permissions', noAuth: true, headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await rawRequest(s.url, { method: 'POST', path: '/api/permissions', headers: { 'content-type': 'text/plain' }, body: '{}', token: TEST_TOKEN })).status).toBe(415)
  })
})

describe('DELETE /api/permissions/:id', () => {
  it('revokes a rule and moves it to the history', async () => {
    const made = await create({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: FORGE })
    const id = made.body.rule.id as string
    const r = await s.api('DELETE', `/api/permissions/${id}`)
    expect(r).toMatchObject({ status: 200, body: { rule: { id, state: 'revoked' } } })
    expect((await list()).some((x) => x.id === id)).toBe(false)
    const history = await s.api('GET', '/api/permissions/history')
    expect(history.body.rules[0]).toMatchObject({ id, state: 'revoked' })
  })

  it('lets a person revoke a default', async () => {
    expect((await s.api('DELETE', '/api/permissions/default-bash')).status).toBe(200)
    expect((await list()).some((x) => x.id === 'default-bash')).toBe(false)
  })

  it('answers 409 the second time and 404 for an unknown id', async () => {
    const id = (await create({ scope: 'global', effect: 'deny', tool: 'Grep' })).body.rule.id as string
    await s.api('DELETE', `/api/permissions/${id}`)
    expect(await s.api('DELETE', `/api/permissions/${id}`)).toMatchObject({ status: 409, body: { error: 'That permission is no longer active.' } })
    expect(await s.api('DELETE', '/api/permissions/perm-nope')).toMatchObject({ status: 404, body: { error: 'Permission not found.' } })
  })
})

describe('DELETE /api/agents/:id/permissions', () => {
  it('revokes the agent rules and leaves global and other agents alone', async () => {
    const mine = (await create({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: FORGE })).body.rule.id as string
    const other = (await create({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'agent-demo-qa' })).body.rule.id as string
    const r = await s.api('DELETE', `/api/agents/${FORGE}/permissions`)
    expect(r).toMatchObject({ status: 200, body: { revoked: [{ id: mine, state: 'revoked' }] } })
    const ids = (await list()).map((x) => x.id)
    expect(ids).toContain(other)
    expect(ids).toContain('default-write')
    expect(await s.api('DELETE', '/api/agents/agent-nope/permissions')).toMatchObject({ status: 404 })
  })
})

describe('GET /api/permissions/history', () => {
  it('is empty at first, newest first afterwards, and at most 200 long', async () => {
    expect((await s.api('GET', '/api/permissions/history')).body.rules).toEqual([])
    for (let i = 0; i < 3; i++) await s.api('DELETE', `/api/permissions/${(await create({ scope: 'global', effect: 'deny', tool: 'Grep', reason: `r${i}` })).body.rule.id}`)
    const rules = (await s.api('GET', '/api/permissions/history')).body.rules as Array<{ reason: string }>
    expect(rules.map((x) => x.reason)).toEqual(['r2', 'r1', 'r0'])
  })
})
