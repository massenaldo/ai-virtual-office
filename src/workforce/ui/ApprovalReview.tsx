import type { ReactNode } from 'react'
import type { ToolReview } from '../types'
import { formatReviewLines, shortDigest, type ReviewSegment } from '../view'

const segment = (s: ReviewSegment, i: number): ReactNode => {
  if (s.kind === 'tab') return <span key={i} className="ws-tab" title="Tab">→{s.text}</span>
  if (s.kind === 'trail') return <span key={i} className="ws-trail" title="Trailing spaces">{'·'.repeat(s.text.length)}</span>
  if (s.kind === 'cr') return <span key={i} className="ws-cr" title="Carriage return">␍</span>
  return s.text
}

function Block({ label, text }: { label?: string; text: string }) {
  const lines = formatReviewLines(text)
  return <>
    {label && <div className="review-label">{label}</div>}
    <pre className="review-pane" tabIndex={0}>
      {lines.length === 0 ? <span className="review-empty">(empty)</span> : lines.map((l) => <div key={l.no} className="review-line"><span className="review-no">{l.no}</span><span className="review-text">{l.segments.map(segment)}</span></div>)}
    </pre>
  </>
}

/**
 * The exact content or change of a Write or Edit, with the workspace, file and action digest it is bound to. The text is
 * rendered as React text (never as markup) and every line is shown. `open` is controlled, so the card knows when it was read.
 */
export default function ApprovalReview({ review, open, onToggle }: { review: ToolReview; open: boolean; onToggle(): void }) {
  const digest = shortDigest(review.digest)
  return <div className="approval-review">
    <dl className="review-facts">
      <div><dt>Workspace</dt><dd>{review.workspaceId}</dd></div>
      <div><dt>File</dt><dd>{review.path}</dd></div>
      <div><dt>Size</dt><dd>{review.bytes} B, {review.lines} {review.lines === 1 ? 'line' : 'lines'}</dd></div>
      <div><dt>Action</dt><dd title={review.digest}>{digest}</dd></div>
    </dl>
    <button type="button" className="panel-link" onClick={onToggle} aria-expanded={open}>{open ? 'Hide full change' : 'Show full change'}</button>
    {open && (review.kind === 'write'
      ? <Block text={review.content} />
      : <>
        <Block label="Replace" text={review.oldString} />
        <Block label="With" text={review.newString} />
        {review.replaceAll && <p className="review-flag">All occurrences are replaced.</p>}
      </>)}
  </div>
}
