// Errors leave the process as a code from a closed list, never as a message: file system messages contain absolute paths.

export const ERROR_CODES = ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EISDIR', 'ENOENT', 'EMFILE', 'EIO', 'write_failed'] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** The error's own code if it is on the list, otherwise `write_failed`. */
export function errorCode(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : 'write_failed'
}

const SENTENCES: Record<ErrorCode, string> = {
  EACCES: 'Permission denied (EACCES).',
  EPERM: 'Operation not permitted (EPERM).',
  ENOSPC: 'No space left on the device (ENOSPC).',
  EROFS: 'The file system is read-only (EROFS).',
  EISDIR: 'A folder is in the way (EISDIR).',
  ENOENT: 'A folder is missing (ENOENT).',
  EMFILE: 'Too many open files (EMFILE).',
  EIO: 'Input/output error (EIO).',
  write_failed: 'The data could not be written.',
}

/** A fixed sentence for a code: safe to show in the UI. */
export const errorSentence = (code: ErrorCode): string => SENTENCES[code]
