import type { OfficeLayout } from './types'

// The wire contract for the saved office layout (GET and PUT /api/layout).

export type LayoutLoadProblem = 'corrupt' | 'unsupported-version'
export type LayoutResponse = { layout: OfficeLayout | null; loadProblem: LayoutLoadProblem | null }
export type PutLayoutBody = { layout: OfficeLayout }
