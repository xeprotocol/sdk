/**
 * Error taxonomy mirroring the node's own classification.
 *
 * The node splits block-submission failures into retryable (HTTP 503, e.g. a
 * block that arrived before its dependency) and terminal (HTTP 400, e.g. a bad
 * signature). Retrying a terminal failure is pointless; giving up on a
 * retryable one loses a block that would have landed. The distinction is
 * carried here so callers never have to guess from a message.
 */
export class XeError extends Error {
  override readonly name: string = 'XeError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A request reached the node and the node refused it. */
export class XeApiError extends XeError {
  override readonly name = 'XeApiError'
  readonly status: number
  readonly retryable: boolean
  readonly body: unknown

  constructor(message: string, status: number, retryable: boolean, body: unknown) {
    super(message)
    this.status = status
    this.retryable = retryable
    this.body = body
  }
}

/** The request never produced a usable answer: DNS, connection, timeout, abort. */
export class XeTransportError extends XeError {
  override readonly name = 'XeTransportError'
  /** Transport failures are always worth retrying — nothing was decided. */
  readonly retryable = true
}

/** The caller asked for something the protocol cannot do. Never retried. */
export class XeUsageError extends XeError {
  override readonly name: string = 'XeUsageError'
}

/** The wallet does not hold enough of the asset to cover the operation. */
export class XeInsufficientFundsError extends XeUsageError {
  override readonly name = 'XeInsufficientFundsError'
  readonly asset: string
  readonly available: bigint
  readonly required: bigint

  constructor(asset: string, available: bigint, required: bigint) {
    super(`insufficient ${asset}: have ${available} micro-units, need ${required}`)
    this.asset = asset
    this.available = available
    this.required = required
  }
}

export function isRetryable(err: unknown): boolean {
  return (
    (err instanceof XeApiError && err.retryable) ||
    err instanceof XeTransportError
  )
}
