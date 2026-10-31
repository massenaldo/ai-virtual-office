import type { IncomingMessage } from 'node:http'
import { HttpError } from './router'

export const MAX_BODY_BYTES = 65536

/** The JSON object in a request body. An empty body is {}; wrong type, size, syntax or shape each get their own status. */
export function readJsonBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return Promise.reject(new HttpError(415, 'Content-Type must be application/json.', 'content_type'))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (fn: () => void) => { if (!done) { done = true; fn() } }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        finish(() => reject(new HttpError(413, `Request body is too large (limit ${Math.round(maxBytes / 1024)} KB).`, 'body_too_large')))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => finish(() => reject(error)))
    req.on('end', () => finish(() => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        return reject(new HttpError(400, 'Request body is not valid JSON.'))
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject(new HttpError(400, 'Request body must be a JSON object.'))
      resolve(value as Record<string, unknown>)
    }))
  })
}
