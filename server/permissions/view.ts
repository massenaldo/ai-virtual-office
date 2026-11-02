import type { PermissionRuleView } from '../../src/workforce/api'
import { ruleState } from './engine'
import type { PermissionRule } from './types'

/** The wire shape of a rule: its state is worked out now, and the digest of a once rule stays on the server. */
export function toRuleView(rule: PermissionRule, now: string): PermissionRuleView {
  const { digest: _digest, ...rest } = rule
  return { ...rest, state: ruleState(rule, now) }
}
