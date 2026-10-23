/** Raised when a file must be left alone; the message is the user-visible reason. */
export class SkipError extends Error {
  constructor(reason, detail) {
    super(reason)
    this.name = 'SkipError'
    this.reason = reason
    this.detail = detail
  }
}

/** True when an error is an intentional skip rather than a bug. */
export function isSkip(error) {
  return error instanceof SkipError
}
