import { describe, expect, it } from 'vitest'
import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from '../../src/workforce/types'
import { NAME_MAX, ROLE_MAX } from '../../src/workforce/operations'
import { parseAgentFile, suggestedRole } from './parse'

const file = (front: string, body = 'Do the work.') => `---\n${front}\n---\n${body}\n`
const ok = (text: string) => {
  const r = parseAgentFile(text)
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r.agent
}
const bad = (text: string) => {
  const r = parseAgentFile(text)
  if (r.ok) throw new Error('expected an error')
  return r.error
}

describe('parseAgentFile', () => {
  it('reads plain, single and double quoted values', () => {
    expect(ok(file('name: Forge\ndescription: d')).name).toBe('Forge')
    expect(ok(file("name: 'Forge'\ndescription: d")).name).toBe('Forge')
    expect(ok(file('name: "Forge"\ndescription: d')).name).toBe('Forge')
  })
  it('takes the body as instructions', () => {
    expect(ok(file('name: Forge', 'Line one.\nLine two.')).instructions).toBe('Line one.\nLine two.')
  })
  it('folds and keeps block scalars', () => {
    expect(ok(file('name: Forge\ndescription: >\n  one\n  two')).description).toBe('one two')
    expect(ok(file('name: Forge\ndescription: |\n  one\n  two')).description).toBe('one\ntwo')
  })
  it('handles a byte order mark and CRLF', () => {
    const lf = ok(file('name: Forge\ndescription: >\n  a\n  b', 'x\ny'))
    const crlf = ok('\uFEFF' + file('name: Forge\ndescription: >\n  a\n  b', 'x\ny').replace(/\n/g, '\r\n'))
    expect(crlf).toEqual(lf)
    expect(JSON.stringify(crlf)).not.toContain('\\r')
  })
  it('lists ignored fields by key name only', () => {
    const a = ok(file('name: Forge\ntools: [Bash]\npermissionMode: bypassPermissions\nhooks:\n  name: Evil\n  model: x y\n  tools: z'))
    expect(a.ignoredFields).toEqual(['tools', 'permissionMode', 'hooks'])
    expect(a.name).toBe('Forge')
    expect(a.model).toBeNull()
    expect(JSON.stringify(a)).not.toContain('bypassPermissions')
  })
  it('maps model', () => {
    expect(ok(file('name: F\nmodel: inherit')).model).toBeNull()
    expect(ok(file('name: F\nmodel: sonnet')).model).toBe('sonnet')
    expect(ok(file('name: F')).model).toBeNull()
    expect(bad(file('name: F\nmodel: no good!'))).toMatch(/model/i)
  })
  it('cuts a long description', () => {
    const a = ok(file(`name: F\ndescription: ${'x'.repeat(AGENT_DESCRIPTION_MAX + 20)}`))
    expect(a.description).toHaveLength(AGENT_DESCRIPTION_MAX)
    expect(a.descriptionCut).toBe(true)
    expect(ok(file('name: F\ndescription: short')).descriptionCut).toBe(false)
  })
  it('refuses malformed files with a sentence', () => {
    expect(bad('name: F\n')).toMatch(/\.$/)
    expect(bad('---\nname: F\nbody')).toMatch(/\.$/)
    expect(bad(file('description: d'))).toMatch(/name/i)
    expect(bad(file('name:   '))).toMatch(/name/i)
    expect(bad(file(`name: ${'x'.repeat(NAME_MAX + 1)}`))).toMatch(/name/i)
    expect(bad(file('name: A\nname: B'))).toMatch(/twice|more than once/i)
    expect(bad(file('name: F', 'x'.repeat(AGENT_INSTRUCTIONS_MAX + 1)))).toMatch(/instructions/i)
  })
  it('refuses unsafe characters in values and body', () => {
    expect(bad(file('name: F\u0007x'))).toMatch(/character/i)
    expect(bad(file('name: F\ndescription: a\u202Eb'))).toMatch(/character/i)
    expect(bad(file('name: F', 'a\u0000b'))).toMatch(/character/i)
    expect(bad(file('name: F', 'a\u200Bb'))).toMatch(/character/i)
  })
  it('masks secrets', () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(40)
    const a = ok(file(`name: F\ndescription: key ${secret}`, `token ${secret}`))
    expect(a.description).toContain('[REDACTED]')
    expect(a.instructions).toContain('[REDACTED]')
    expect(a.description + a.instructions).not.toContain(secret)
    expect(a.secretsMasked).toBe(true)
    expect(ok(file('name: F')).secretsMasked).toBe(false)
  })
})

describe('parseAgentFile hardening', () => {
  it('refuses oversized instructions even when masking would shrink them', () => {
    const big = '-----BEGIN RSA PRIVATE KEY-----\n' + 'x'.repeat(AGENT_INSTRUCTIONS_MAX + 5000)
    expect(bad(file('name: F', big))).toMatch(/instructions/i)
    expect(bad(file('name: F', 'keep\n' + big))).toMatch(/instructions/i)
  })
  it('refuses a front matter line it cannot read as a key', () => {
    for (const line of ['tools.allow: Bash', 'allowed tools: Bash', `${'k'.repeat(41)}: x`, 'k\u200Bk: x', '{name: Evil, tools: [Bash]}', 'just words']) {
      expect(bad(file(`name: F\n${line}`))).toMatch(/key/i)
    }
  })
  it('lists quoted ignored keys and counts quoted accepted keys', () => {
    expect(ok(file('name: F\n"permissionMode": bypassPermissions\n\'tools\': [Bash]')).ignoredFields).toEqual(['permissionMode', 'tools'])
    expect(bad(file('name: A\n"name": B'))).toMatch(/more than once/)
    expect(ok(file('"name": Q')).name).toBe('Q')
  })
  it('refuses more than 50 other fields', () => {
    const many = Array.from({ length: 51 }, (_, i) => `k${i}: x`).join('\n')
    expect(bad(file(`name: F\n${many}\npermissionMode: bypassPermissions`))).toMatch(/more than 50/)
    const fifty = Array.from({ length: 50 }, (_, i) => `k${i}: x`).join('\n')
    expect(ok(file(`name: F\n${fifty}`)).ignoredFields).toHaveLength(50)
  })
  it('does not list a secret-shaped key verbatim', () => {
    const key = 'ghp_' + 'a'.repeat(36)
    const a = ok(file(`name: F\n${key}: x`))
    expect(JSON.stringify(a)).not.toContain(key)
    expect(a.ignoredFields).toHaveLength(1)
  })
  it('refuses a secret-shaped model', () => {
    expect(bad(file('name: F\nmodel: ghp_' + 'a'.repeat(36)))).toMatch(/model/i)
    expect(bad(file('name: F\nmodel: sk-ant-api03-' + 'a'.repeat(40)))).toMatch(/model/i)
  })
  it('does not treat unicode whitespace after a marker as a marker', () => {
    expect(bad('---\u00A0\nname: F\n---\nbody')).toMatch(/\.$/)
    expect(bad('---\nname: F\n---\u2028\nbody')).toMatch(/never closed/)
    expect(ok('---  \nname: F\n---\t\nbody').name).toBe('F')
  })
})

describe('parseAgentFile round 2', () => {
  it('refuses indented lines with no key open', () => {
    expect(bad('---\n# note\n  permissionMode: bypassPermissions\n  tools: [Bash]\nname: F\n---\nb')).toMatch(/key/i)
    expect(bad('---\n  permissionMode: bypassPermissions\n\ttools: [Bash]\nname: F\n---\nb')).toMatch(/key/i)
  })
  it('a comment does not detach the lines after it from their key', () => {
    const a = ok(file('name: F\ndescription: |\n  shown\n# c\n  hidden tail'))
    expect(a.description).toBe('shown\nhidden tail')
  })
  it('only a # in column 0 is a comment', () => {
    expect(bad('---\n # tools: Bash\nname: F\n---\nb')).toMatch(/key/i)
    expect(bad(file('name: F\n\uFEFF# x'))).toMatch(/key/i)
    expect(ok(file('name: F\ndescription: a\n # b')).description).toContain('# b')
  })
  it('attaches column-0 list items to the open key', () => {
    expect(ok(file('name: F\ntools:\n- Read\n- Write')).ignoredFields).toEqual(['tools'])
    expect(bad('---\n- tools: Bash\nname: F\n---\nb')).toMatch(/key/i)
    expect(bad(file('# c\n- tools: Bash\nname: F'))).toMatch(/key/i)
  })
})

describe('suggestedRole', () => {
  it('makes a sentence from the file name', () => {
    expect(suggestedRole('backend-engineer.md')).toBe('Backend engineer')
    expect(suggestedRole('qa_lead.md')).toBe('Qa lead')
    expect(suggestedRole(`${'a'.repeat(200)}.md`)).toHaveLength(ROLE_MAX)
  })
  describe('invisible characters and emoji', () => {
    const body = (b: string) => parseAgentFile(`---\nname: F\n---\n${b}\n`)
    it.each(['\u26a0\ufe0f warning', '\u2714\ufe0f done', '1\ufe0f\u20e3 first', '\u{1f468}\u200d\u{1f4bb} dev', '\u2764\ufe0f\u200d\u{1f525} fire'])('allows a well-formed emoji sequence: %s', (t) => {
      const r = body(t)
      expect(r.ok).toBe(true)
    })
    it.each([
      ['a zero-width joiner between letters', 'a\u200db', 'U+200D'],
      ['U+FE0F after a letter', 'a\ufe0f', 'U+FE0F'],
      ['a zero-width space', 'a\u200bb', 'U+200B'],
      ['a right-to-left override', 'a\u202eb', 'U+202E'],
      ['a joiner after an emoji but before a letter', '\u{1f468}\u200dx', 'U+200D'],
      ['a joiner before an emoji but after a letter', 'x\u200d\u{1f4bb}', 'U+200D'],
      ['a trailing joiner after an emoji', '\u{1f468}\u200d', 'U+200D'],
    ])('refuses %s and names the line and code point', (_n, t, cp) => {
      const r = parseAgentFile(`---\nname: F\n---\nok\n${t}\n`)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(`Line 5 has an invisible character (${cp}).`)
    })
    it('names the line of a bad character in the front matter', () => {
      const r = parseAgentFile('---\nname: F\ndescription: a\u200bb\n---\nx\n')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('Line 3 has an invisible character (U+200B).')
    })
  })
  it('decodes only \\n \\t \\" and \\\\ in double-quoted values', () => {
    const a = ok(file('name: F\ndescription: "line\\none \\"q\\" \\\\ \\u0041 \\x"'))
    expect(a.description).toBe('line\none "q" \\ \\u0041 \\x')
    expect(ok(file("name: F\ndescription: 'a\\nb'")).description).toBe('a\\nb')
    expect(ok(file('name: F\ndescription: a\\nb')).description).toBe('a\\nb')
  })
  it('treats inherit case-insensitively', () => {
    expect(ok(file('name: F\nmodel: Inherit')).model).toBeNull()
    expect(ok(file('name: F\nmodel: INHERIT')).model).toBeNull()
  })
  it('keeps a lone closing bracket with the open key, and refuses it with none', () => {
    expect(ok(file('name: F\ntools: [\n  Read\n]\nmodel: sonnet')).ignoredFields).toEqual(['tools'])
    expect(ok(file('name: F\nhooks: {\n  a: b\n}')).ignoredFields).toEqual(['hooks'])
    expect(bad(file(']\nname: F'))).toMatch(/key: value/)
  })
  it('says how long the instructions are when over the limit', () => {
    expect(bad(file('name: F', 'x'.repeat(AGENT_INSTRUCTIONS_MAX + 7)))).toContain(`${AGENT_INSTRUCTIONS_MAX + 7}`)
  })

})
