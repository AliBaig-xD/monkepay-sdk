import type { MonkePayConfig, MonkePayErrorCode, MonkePayErrorContext, MonkePayErrorPhase, PaymentMode } from './types.js'

export type MonkePayPublicErrorStatus = 401 | 500 | 502

const PUBLIC_ERROR_MESSAGES: Record<MonkePayErrorCode, string> = {
  INVALID_CONFIG: 'MonkePay SDK configuration is invalid.',
  UNLOCK_VERIFY_FAILED: 'Unlock token verification failed.',
  WALLET_RESOLVE_FAILED: 'MonkePay SDK could not resolve the payout wallet.',
  PAYMENT_MIDDLEWARE_FAILED: 'MonkePay SDK could not complete payment validation.',
  EVENT_RECORD_FAILED: 'MonkePay SDK could not record the payment event.',
  ON_PAYMENT_CALLBACK_FAILED: 'MonkePay SDK onPayment callback failed.',
  SDK_INTERNAL_ERROR: 'MonkePay SDK encountered an internal error.',
}

const STATUS_BY_ERROR_CODE: Record<MonkePayErrorCode, MonkePayPublicErrorStatus> = {
  INVALID_CONFIG: 500,
  UNLOCK_VERIFY_FAILED: 401,
  WALLET_RESOLVE_FAILED: 502,
  PAYMENT_MIDDLEWARE_FAILED: 502,
  EVENT_RECORD_FAILED: 502,
  ON_PAYMENT_CALLBACK_FAILED: 500,
  SDK_INTERNAL_ERROR: 500,
}

export class MonkePaySdkError extends Error {
  code: MonkePayErrorCode
  phase: MonkePayErrorPhase
  recoverable: boolean
  statusCode: MonkePayPublicErrorStatus
  requestId?: string
  txHash?: string

  constructor(input: {
    code: MonkePayErrorCode
    phase: MonkePayErrorPhase
    recoverable: boolean
    message?: string
    statusCode?: MonkePayPublicErrorStatus
    requestId?: string
    txHash?: string
    cause?: unknown
  }) {
    super(input.message ?? PUBLIC_ERROR_MESSAGES[input.code], {
      cause: input.cause,
    })
    this.name = 'MonkePaySdkError'
    this.code = input.code
    this.phase = input.phase
    this.recoverable = input.recoverable
    this.statusCode = input.statusCode ?? STATUS_BY_ERROR_CODE[input.code]
    this.requestId = input.requestId
    this.txHash = input.txHash
  }
}

export function createSdkError(input: {
  code: MonkePayErrorCode
  phase: MonkePayErrorPhase
  recoverable: boolean
  message?: string
  statusCode?: MonkePayPublicErrorStatus
  requestId?: string
  txHash?: string
  cause?: unknown
}): MonkePaySdkError {
  return new MonkePaySdkError(input)
}

export function toPublicErrorResponse(error: unknown): {
  status: MonkePayPublicErrorStatus
  body: {
    error: {
      code: MonkePayErrorCode
      message: string
      recoverable: boolean
      requestId?: string
    }
  }
} {
  if (error instanceof MonkePaySdkError) {
    return {
      status: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: PUBLIC_ERROR_MESSAGES[error.code],
          recoverable: error.recoverable,
          requestId: error.requestId,
        },
      },
    }
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'SDK_INTERNAL_ERROR',
        message: PUBLIC_ERROR_MESSAGES.SDK_INTERNAL_ERROR,
        recoverable: false,
      },
    },
  }
}

export function sanitizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message || fallback
  }

  if (typeof error === 'string' && error.trim() !== '') {
    return error
  }

  return fallback
}

export async function emitOnErrorSafe(
  config: MonkePayConfig,
  input: {
    code: MonkePayErrorCode
    phase: MonkePayErrorPhase
    endpoint: string
    paymentMode: PaymentMode
    recoverable: boolean
    requestId?: string
    txHash?: string
    statusCode?: number
    message: string
    cause?: unknown
  },
): Promise<void> {
  const payload: MonkePayErrorContext = {
    code: input.code,
    phase: input.phase,
    endpoint: input.endpoint,
    paymentMode: input.paymentMode,
    recoverable: input.recoverable,
    requestId: input.requestId,
    txHash: input.txHash,
    statusCode: input.statusCode,
    message: input.message,
    cause: input.cause instanceof Error 
        ? { message: input.cause.message, name: input.cause.name }
        : typeof input.cause === "string"
          ? { message: input.cause, name: "UnknownError" }
          : undefined,
  }

  try {
    await config.onError?.(payload)
  } catch (callbackError) {
    console.warn('[MonkePay] onError callback failed', sanitizeErrorMessage(callbackError, 'unknown callback error'))
  }
}
