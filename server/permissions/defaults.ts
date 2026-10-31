import type { PermissionEffect, PermissionRule } from './types'

// What every agent may do before anyone changes anything. It matches the policy of today: reads need no approval, writes ask,
// and execute and network tools are refused (a person must revoke a default deny before such a tool can even be asked about).

const DEFAULTS: ReadonlyArray<readonly [tool: string, effect: PermissionEffect]> = [
  ['Read', 'allow'], ['Glob', 'allow'], ['Grep', 'allow'], ['Write', 'ask'], ['Edit', 'ask'], ['Bash', 'deny'], ['WebFetch', 'deny'], ['WebSearch', 'deny'],
]

export function defaultRules(now: string): PermissionRule[] {
  return DEFAULTS.map(([tool, effect]) => ({
    id: `default-${tool.toLowerCase()}`, scope: 'global', effect, tool, agentId: null, taskId: null, pathPattern: null, digest: null,
    createdAt: now, createdBy: 'default', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null,
  }))
}
