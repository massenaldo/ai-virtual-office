import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createOfficeClock } from '../../office/officeClock'
import { OfficeClockContext } from '../officeClockContext'
import OfficeClockChip from './OfficeClockChip'

const show = (iso: string, speed = 1) => renderToStaticMarkup(
  <OfficeClockContext.Provider value={createOfficeClock({ nowMs: Date.parse(iso), speed, routine: true }, () => 0)}><OfficeClockChip speed={speed}/></OfficeClockContext.Provider>,
)

describe('OfficeClockChip', () => {
  it('shows Jakarta time whatever the viewer zone', () => {
    expect(show('2026-11-09T12:03:00+07:00')).toContain('Jakarta 12:03')
    expect(show('2026-11-09T05:03:00Z')).toContain('Jakarta 12:03')
  })
  it('adds the speed for a dev clock', () => {
    expect(show('2026-11-09T12:03:00+07:00', 60)).toContain('Jakarta 12:03 ×60')
  })
  it('is a status chip the scene can see through', () => {
    expect(show('2026-11-09T12:03:00+07:00')).toContain('class="scene-chip"')
  })
})
