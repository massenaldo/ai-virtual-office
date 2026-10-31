import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A temp WORKSPACE_ROOT (real path) with one folder per id, and the env that configures it. */
export function makeWorkspaceRoot(ids: string[] = ['sandbox']): { root: string; env: { WORKSPACE_ROOT: string; WORKSPACES: string }; path(id: string): string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vo-ws-')))
  for (const id of ids) mkdirSync(join(root, id), { recursive: true })
  return {
    root,
    env: { WORKSPACE_ROOT: root, WORKSPACES: ids.map((id) => `${id}:${id}`).join(',') },
    path: (id) => join(root, id),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
