import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getBrowserStorage } from '../layout/storage'
import type { WorkforceController, WorkforceSnapshot } from './controller'
import { createControllerFor, resolveWorkforceSource } from './source'

export type Workforce = WorkforceSnapshot & { actions: WorkforceController }

/**
 * One workforce controller per mount, created in an effect so StrictMode's mount-unmount-mount disposes the first
 * one cleanly instead of leaving a disposed controller in use. Null until the effect has run.
 */
export function useWorkforce(): Workforce | null {
  const [controller, setController] = useState<WorkforceController | null>(null)
  useEffect(() => {
    const c = createControllerFor(resolveWorkforceSource(import.meta.env.VITE_WORKFORCE_API_URL), { storage: getBrowserStorage() })
    setController(c)
    return () => c.dispose()
  }, [])
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller])
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? null, [controller])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  return controller && snapshot ? { ...snapshot, actions: controller } : null
}
