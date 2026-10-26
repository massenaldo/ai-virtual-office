import type { DepartmentId } from '../layout/types'

export type FloorFinish = 'concrete' | 'carpet' | 'oak' | 'epoxy'

/** Floor finish per room, derived from its department so the saved layout format stays unchanged. */
export function floorFinishFor(department: DepartmentId): FloorFinish {
  if (department === 'executive' || department === 'meeting') return 'oak'
  if (department === 'devops') return 'epoxy'
  return 'carpet'
}

export type Side = 'solid' | 'glass'
/** Which side walls are glazed; the back is always glass and the front always open. */
export type PartitionStyle = { left: Side; right: Side }

const GLAZED_RIGHT: PartitionStyle = { left: 'solid', right: 'glass' }
const ALL_SOLID: PartitionStyle = { left: 'solid', right: 'solid' }

/** Executive office and meeting room get a framed glass side; the solid left wall carries art or a whiteboard. */
export function partitionStyle(department: DepartmentId): PartitionStyle {
  return department === 'executive' || department === 'meeting' ? GLAZED_RIGHT : ALL_SOLID
}
