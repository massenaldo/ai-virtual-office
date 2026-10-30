import { addActivity, agentAtDesk, emptyWorkforce } from './operations'
import type { Agent, WorkforceState } from './types'

type DemoAgent = Omit<Agent, 'createdAt' | 'lastActivityAt'>

const demo = (id: string, name: string, role: string, department: Agent['department'], deskId: string): DemoAgent =>
  ({ id, name, role, department, deskId, status: 'idle', currentTaskId: null, runtimeMode: 'mock', demo: true })

// Each sits at a desk in the default office: its own room where there is one, otherwise the open floor.
export const DEMO_AGENTS: readonly DemoAgent[] = [
  demo('agent-demo-pm', 'Atlas', 'Delivery planner', 'project-management', 'desk-03'),
  demo('agent-demo-lead', 'Meridian', 'Architecture lead', 'tech-lead', 'desk-05'),
  demo('agent-demo-backend', 'Forge', 'API engineer', 'backend', 'desk-07'),
  demo('agent-demo-frontend', 'Pixel', 'Interface engineer', 'frontend', 'desk-11'),
  demo('agent-demo-qa', 'Sentry', 'Test engineer', 'qa', 'desk-13'),
  demo('agent-demo-devops', 'Relay', 'Release engineer', 'devops', 'desk-09'),
]

/** Re-adds missing demo agents by id; a demo agent whose desk is taken comes back unassigned. */
export function restoreDemoAgents(s: WorkforceState, now: string): WorkforceState {
  return DEMO_AGENTS.reduce((state, d) => {
    if (state.agents.some((a) => a.id === d.id)) return state
    const deskId = d.deskId !== null && agentAtDesk(state, d.deskId) ? null : d.deskId
    const agent: Agent = { ...d, deskId, createdAt: now, lastActivityAt: null }
    return addActivity({ ...state, agents: [...state.agents, agent] }, { type: 'agent-created', agentId: d.id, taskId: null, message: 'Demo agent added (mock data)', timestamp: now, source: 'mock' })
  }, s)
}

export function createDemoWorkforce(now: string): WorkforceState {
  return restoreDemoAgents(emptyWorkforce(), now)
}
