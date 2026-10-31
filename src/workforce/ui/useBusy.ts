import { useCallback, useEffect, useRef, useState } from 'react'

/** Runs an async action with a busy flag and ignores its result once the component has unmounted. */
export function useBusy(): { busy: boolean; run<T>(action: () => Promise<T> | T): Promise<T | undefined> } {
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const run = useCallback(async <T,>(action: () => Promise<T> | T): Promise<T | undefined> => {
    setBusy(true)
    try {
      const result = await action()
      return mounted.current ? result : undefined
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])
  return { busy, run }
}
