import type { Agent, AgentTask } from '../../src/workforce/types'

/** The task as the model reads it: the title, then the description. Both were typed by the person who started the task. */
export function buildPrompt(task: Pick<AgentTask, 'title' | 'description'>): string {
  return task.description.trim() === '' ? task.title : `${task.title}\n\n${task.description}`
}

/** A short custom prompt. The Claude Code preset is not used: it describes built-in tools this session does not have. */
export function buildSystemPrompt(agent: Pick<Agent, 'name' | 'role'>): string {
  return [
    `You are ${agent.name}, ${agent.role}, an AI agent in a virtual office.`,
    'In this session you have no tools. You cannot read or change files, run commands or reach the internet, so answer from the task text alone and say so plainly if the task needs something you cannot do.',
    'Reply briefly and directly.',
  ].join(' ')
}
