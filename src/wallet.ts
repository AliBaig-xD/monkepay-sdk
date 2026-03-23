// packages/sdk/src/wallet.ts
// Resolves wallet address from API credentials via MonkePay API

import {
  getCachedWallet, 
  validateAndTrimAuth, 
  upsertCachedWallet,
  monkePayRequest,
} from './utils.js'
import type { 
  PaymentAuthOptions, 
  PaymentRecordPayload, 
  PaymentRecordResult, 
  UnlockVerifyPayload, 
  UnlockVerifyResult, 
  WalletInfo,
} from './types.js'

export async function resolveWallet(auth: PaymentAuthOptions): Promise<WalletInfo> {
  const validated = validateAndTrimAuth(auth)

  const cacheKey = `key:${validated.apiBase}:${validated.keyId}`
  const cached = getCachedWallet(cacheKey)
  if (cached) return cached

  const data = await monkePayRequest<WalletInfo>(
    '/wallets/by-api-key',
    'GET',
    validated,
    undefined,
    { timeoutMs: 5_000 },
  )

  if (!data) {
    throw new Error('Wallet not found')
  }

  upsertCachedWallet(cacheKey, data)
  return data
}

export async function recordPaymentEvent(
  payload: PaymentRecordPayload,
  auth: PaymentAuthOptions,
): Promise<PaymentRecordResult> {
  const validated = validateAndTrimAuth(auth)
  const data = await monkePayRequest<PaymentRecordResult>(
    '/events/payment',
    'POST',
    validated,
    payload,
  )

  return {
    unlockToken: typeof data?.unlockToken === 'string' ? data.unlockToken : undefined,
  }
}

export async function verifyUnlockToken(
  payload: UnlockVerifyPayload,
  auth: PaymentAuthOptions,
): Promise<UnlockVerifyResult> {
  const validated = validateAndTrimAuth(auth)
  const data = await monkePayRequest<UnlockVerifyResult>(
    '/events/unlock/verify',
    'POST',
    validated,
    payload,
    { allow401: true, allow404: true },
  )

  return { unlocked: data?.unlocked === true }
}
