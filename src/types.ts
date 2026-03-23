// packages/sdk/src/types.ts

export type SupportedNetwork = 'base' | 'base-sepolia'
export type PaymentMode = 'per_request' | 'one_time'
export type MonkePayErrorPhase =
  | 'config'
  | 'unlock_verify'
  | 'wallet_resolve'
  | 'x402'
  | 'event_record'
  | 'onPayment'
  | 'unknown'

export type MonkePayErrorCode =
  | 'INVALID_CONFIG'
  | 'UNLOCK_VERIFY_FAILED'
  | 'WALLET_RESOLVE_FAILED'
  | 'PAYMENT_MIDDLEWARE_FAILED'
  | 'EVENT_RECORD_FAILED'
  | 'ON_PAYMENT_CALLBACK_FAILED'
  | 'SDK_INTERNAL_ERROR'

export interface MonkePayErrorContext {
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
}

export interface MonkePayConfig {
  /** Price per request in USDC, e.g. '0.001' */
  price: string

  /** Payment behavior for protected endpoints */
  paymentMode?: PaymentMode

  /** Response/request header used for one-time unlock token */
  unlockHeaderName?: string

  /** Per-developer API key id for backend event auth */
  apiKeyId: string

  /** Per-developer API key secret for backend event auth */
  apiKeySecret: string

  /**
   * MonkePay backend URL. Defaults to 'https://api.monkepay.xyz'.
   * Override for self-hosted deployments or local development.
   */
  apiUrl?: string

  /**
   * Base URL of the developer's API as seen by agents externally,
   * e.g. 'https://api.example.com'. Used to construct the x402
   * resource URL for payment requirements.
   *
   * Required when running behind a reverse proxy (Nginx, Cloudflare, etc.)
   * without trustProxy enabled, or when protocol/host detection is unreliable.
   * When provided, takes precedence over request-derived protocol and host.
   */
  baseUrl?: string

  /** Optional: callback fired on each successful payment */
  onPayment?: (payment: PaymentEvent) => void | Promise<void>

  /**
   * Optional: callback fired on internal SDK errors.
   * This callback is observability-focused and should not throw.
   */
  onError?: (error: MonkePayErrorContext) => void | Promise<void>
}

/** Interface representing a payment event */
export interface PaymentEvent {
  agentAddress: string
  amountUSDC: string
  txHash: string
  timestamp: Date
  endpoint: string
}

/** Interface representing a wallet's information */
export interface WalletInfo {
  address: string
  network: SupportedNetwork
}

/** Interface representing the payload for recording a payment event */
export interface PaymentRecordPayload {
  agentAddress: string
  amountUSDC: string
  txHash: string
  endpoint: string
}

/** Interface representing the payload for unlock verification */
export interface UnlockVerifyPayload {
  endpoint: string
  token: string
}

/** Interface representing the result of recording a payment event */
export interface PaymentRecordResult {
  unlockToken?: string
}

/** Interface representing the result of unlock token verification */
export interface UnlockVerifyResult {
  unlocked: boolean
}

/** Internal type for validated and normalized auth parameters */
export interface PaymentAuthOptions {
  apiKeyId: string
  apiKeySecret: string
  apiUrl?: string
}

/** Cache wallet info in memory to avoid repeated API calls */
export type WalletCacheEntry = {
  wallet: WalletInfo
  expiresAtMs: number
  lastAccessAtMs: number
}
