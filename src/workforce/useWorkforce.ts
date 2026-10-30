import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { getBrowserStorage } from '../layout/storage'
import { createWorkforceController, type WorkforceController, type WorkforceSnapshot } from './controller'

export type Workforce = WorkforceSnapshot & { actions: WorkforceController }

/**
 * One workforce controller per mount, created in an effect so StrictMode's mount-unmount-mount disposes the first
 * one cleanly instead of leaving a disposed controller in use. Null until the effect has run.
 */
export function useWorkforce(): Workforce | null {
  const [controller, setController] = useState<WorkforceController | null>(null)
  useEffect(() => {
    const c = createWorkforceController({ storage: getBrowserStorage() })
    setController(c)
    return () => c.dispose()
  }, [])
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller])
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? null, [controller])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  return controller && snapshot ? { ...snapshot, actions: controller } : null
}
