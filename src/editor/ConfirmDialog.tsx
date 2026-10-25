import { useEffect, useRef } from 'react'

export type ConfirmAction = { label: string; tone?: 'danger' | 'primary'; onClick(): void }

export type ConfirmDialogProps = { open: boolean; title: string; message: string; actions: ConfirmAction[]; cancelLabel?: string; onClose(): void }

/** In-app modal used instead of window.confirm so it matches the UI and never blocks the page. */
export default function ConfirmDialog({ open, title, message, actions, cancelLabel = 'Cancel', onClose }: ConfirmDialogProps) {
  const firstButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    firstButton.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])
  if (!open) return null
  return <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message">
      <h2 id="dialog-title">{title}</h2>
      <p id="dialog-message">{message}</p>
      <div className="dialog-actions">
        <button ref={firstButton} className="dialog-button" onClick={onClose}>{cancelLabel}</button>
        {actions.map((a) => <button key={a.label} className={`dialog-button ${a.tone ?? ''}`} onClick={() => { a.onClick(); onClose() }}>{a.label}</button>)}
      </div>
    </div>
  </div>
}
