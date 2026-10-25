import type { DepartmentId } from '../layout/types'

export type FloorFinish = 'concrete' | 'carpet' | 'oak' | 'epoxy'

/** Floor finish per room, derived from its department so the saved layout format stays unchanged. */
export function floorFinishFor(department: DepartmentId): FloorFinish {
  if (department === 'executive' || department === 'meeting') return 'oak'
  if (department === 'devops') return 'epoxy'
  return 'carpet'
}
