import { useRef, useState, type FormEvent } from 'react'
import { useBusy } from './useBusy'

export type PairingFormProps = { onPair(token: string): Promise<{ ok: boolean; error?: string }> }

/** Runs one pairing attempt. Returns the message to show, or null when it worked. A thrown error never echoes the token. */
export async function attemptPairing(onPair: PairingFormProps['onPair'], token: string): Promise<string | null> {
  try {
    const r = await onPair(token)
    return r.ok ? null : (r.error ?? 'Pairing failed.')
  } catch {
    return 'Pairing failed.'
  }
}

/**
 * Asks for the API token once. The token lives only in the input's own value until submit, is cleared at once and
 * after every attempt, and goes nowhere but onPair: no state, no storage.
 */
export default function PairingForm({ onPair }: PairingFormProps) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const { busy, run } = useBusy()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !input.current) return
    const token = input.current.value
    input.current.value = ''
    const result = await run(() => attemptPairing(onPair, token))
    if (input.current) input.current.value = ''
    if (result !== undefined) setError(result)
  }
  return <form onSubmit={submit} noValidate>
    <div className="field-group-label">Connect to the backend</div>
    <label className="field"><span>API token</span><input ref={input} className="field-input" type="password" autoComplete="off" spellCheck={false} autoFocus disabled={busy}/></label>
    <p className="panel-hint">Paste the API token: the token file in the backend's data folder, or your API_TOKEN. Open the app at the same address you started the backend with (127.0.0.1 or localhost); a session made on one is not valid on the other.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="panel-actions"><button type="submit" className="panel-button primary" disabled={busy}>Connect</button></div>
  </form>
}
