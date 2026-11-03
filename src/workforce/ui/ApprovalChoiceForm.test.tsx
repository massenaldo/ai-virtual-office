import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ApprovalChoiceForm, { type ApprovalChoiceFormProps } from './ApprovalChoiceForm'

const props = (over: Partial<ApprovalChoiceFormProps> = {}): ApprovalChoiceFormProps => ({ approvalId: 'ap1', tool: 'Write', digest: 'ab'.repeat(32), agentName: 'Nova', scope: 'once', onScope: () => {}, canAllow: true, busy: false, onAllow: () => {}, onReject: () => {}, ...over })
const html = (over?: Partial<ApprovalChoiceFormProps>) => renderToStaticMarkup(<ApprovalChoiceForm {...props(over)}/>)
const button = (h: string, label: string) => h.split('<button').find((b) => b.includes(`</svg> ${label}</button>`)) ?? ''

/** Values of the radios that are checked, whatever order the attributes print in. */
const checkedValues = (h: string): string[] => (h.match(/<input[^>]*>/g) ?? []).filter((i) => / checked=""/.test(i)).map((i) => /value="([^"]*)"/.exec(i)![1])

describe('ApprovalChoiceForm', () => {
  it('offers Once, This task and This agent for a file tool, with Once selected first', () => {
    const h = html()
    expect(h.match(/type="radio"/g)).toHaveLength(3)
    for (const l of ['Once', 'This task', 'This agent']) expect(h).toContain(`<span>${l}</span>`)
    expect(checkedValues(h)).toEqual(['once'])
  })

  it.each(['Bash', 'WebFetch', 'WebSearch'])('offers Once only for %s and says why', (tool) => {
    const h = html({ tool })
    expect(h.match(/type="radio"/g)).toHaveLength(1)
    expect(h).toContain('can only be allowed once')
  })

  it('offers Once only for a simulated approval (no digest), whatever the tool', () => {
    const h = html({ digest: null })
    expect(h.match(/type="radio"/g)).toHaveLength(1)
    expect(h).toContain('A simulated request can only be allowed once')
  })

  it('a leftover choice that the tool does not allow falls back to Once', () => {
    expect(checkedValues(html({ tool: 'Bash', scope: 'agent' }))).toEqual(['once'])
    expect(html({ tool: 'Bash', scope: 'agent' })).toContain('Allow Bash once')
  })

  it('names the chosen scope in words that come from the approval', () => {
    expect(checkedValues(html({ scope: 'agent' }))).toEqual(['agent'])
    expect(html({ scope: 'agent' })).toContain('Allow Write for Nova on every task until you revoke it.')
    expect(html({ scope: 'task' })).toContain('for the rest of this task')
  })

  it('Allow waits for the review but Reject never does', () => {
    const h = html({ canAllow: false })
    expect(button(h, 'Allow')).toContain('disabled')
    expect(button(h, 'Reject')).not.toContain('disabled')
  })

  it('both buttons and the choices are disabled while a decision is in flight', () => {
    const h = html({ busy: true })
    expect(button(h, 'Allow')).toContain('disabled')
    expect(button(h, 'Reject')).toContain('disabled')
    expect(h).toContain('<fieldset class="scope-choice" disabled')
  })

  it('groups the radios with a legend and gives each its own name per approval', () => {
    const h = html()
    expect(h).toContain('<legend>Allow for</legend>')
    expect(h).toContain('name="scope-ap1"')
  })
})
