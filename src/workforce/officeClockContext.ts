import { createContext, useContext } from 'react'
import { createOfficeClock, type OfficeClock } from '../office/officeClock'

/** The office clock for the whole page. Without a provider (tests, browser-only demo) it is real time with the routine on. */
export const OfficeClockContext = createContext<OfficeClock>(createOfficeClock(null, Date.now))

export const useOfficeClock = (): OfficeClock => useContext(OfficeClockContext)
