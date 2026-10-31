import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolReview } from '../types'
import { approveEnabled, formatReviewLines } from '../view'
import ApprovalReview from './ApprovalReview'

const DIGEST = '0123456789abcdef'.repeat(4)
const write = (content: string): ToolReview => ({ kind: 'write', path: 'src/a.ts', bytes: content.length, lines: content.split('\n').length, content, workspaceId: 'sandbox', digest: DIGEST })
const edit: ToolReview = { kind: 'edit', path: 'src/a.ts', bytes: 4, lines: 2, oldString: 'foo', newString: 'bar', replaceAll: true, workspaceId: 'sandbox', digest: DIGEST }
const html = (review: ToolReview, open: boolean) => renderToStaticMarkup(<ApprovalReview review={review} open={open} onToggle={() => {}} />)

describe('formatReviewLines', () => {
  it('numbers every line and never drops one', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n')
    const lines = formatReviewLines(text)
    expect(lines).toHaveLength(2000)
    expect(lines[0].no).toBe(1)
    expect(lines.at(-1)).toMatchObject({ no: 2000, segments: [{ kind: 'text', text: 'line 2000' }] })
  })

  it('marks a carriage return in the middle of a line, not only at its end', () => {
    expect(formatReviewLines('a\rb')[0].segments).toEqual([{ kind: 'text', text: 'a' }, { kind: 'cr', text: '\r' }, { kind: 'text', text: 'b' }])
  })

  it('does not count the empty piece after a final newline, and shows nothing for empty text', () => {
    expect(formatReviewLines('a\nb\n')).toHaveLength(2)
    expect(formatReviewLines('')).toEqual([])
  })

  it('marks tabs, trailing spaces and carriage returns', () => {
    expect(formatReviewLines('a\tb  \r\nc')[0].segments).toEqual([{ kind: 'text', text: 'a' }, { kind: 'tab', text: '\t' }, { kind: 'text', text: 'b' }, { kind: 'trail', text: '  ' }, { kind: 'cr', text: '\r' }])
    expect(formatReviewLines('x ')[0].segments.at(-1)).toEqual({ kind: 'trail', text: ' ' })
    expect(formatReviewLines('a b')[0].segments).toEqual([{ kind: 'text', text: 'a b' }])
  })

  it('keeps the characters exactly, so the pane shows what would be written', () => {
    const text = 'α\t😀  \n  indented\n'
    expect(formatReviewLines(text).map((l) => l.segments.map((s) => s.text).join('')).join('\n')).toBe(text.replace(/\n$/, ''))
  })
})

describe('approveEnabled', () => {
  it('needs the review opened when there is one, and is free when there is none', () => {
    expect(approveEnabled(write('x'), false)).toBe(false)
    expect(approveEnabled(write('x'), true)).toBe(true)
    expect(approveEnabled(null, false)).toBe(true)
  })
})

describe('ApprovalReview', () => {
  it('shows the workspace, file, size, lines and digest prefix, and no text until opened', () => {
    const closed = html(write('secret body'), false)
    for (const text of ['sandbox', 'src/a.ts', '11 B', '0123456789ab', 'Show full change']) expect(closed).toContain(text)
    expect(closed).not.toContain('secret body')
  })

  it('shows every numbered line of a large Write when opened', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n')
    const open = html(write(text), true)
    expect(open).toContain('Hide full change')
    expect(open).toContain('line 2000')
    expect(open).toContain('>2000<')
    expect(open).not.toContain('…')
  })

  it('shows an Edit as Replace and With blocks with the all-occurrences flag', () => {
    const open = html(edit, true)
    expect(open).toContain('Replace')
    expect(open).toContain('With')
    expect(open).toContain('foo')
    expect(open).toContain('bar')
    expect(open).toContain('All occurrences are replaced')
    expect(html({ ...edit, replaceAll: false }, true)).not.toContain('All occurrences')
  })

  it('renders markup in the content as text', () => {
    const open = html(write('<script>alert(1)</script><img src=x onerror=y>'), true)
    expect(open).not.toContain('<script>')
    expect(open).not.toContain('<img')
    expect(open).toContain('&lt;script&gt;')
  })

  it('marks whitespace in the pane', () => {
    const open = html(write('a\tb  '), true)
    expect(open).toContain('ws-tab')
    expect(open).toContain('ws-trail')
  })
})
