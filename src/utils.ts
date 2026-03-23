import { createHmac, randomUUID } from "crypto";
import { PaymentAuthOptions, WalletCacheEntry, WalletInfo } from "./types";

const DEFAULT_MONKEPAY_API = "https://api.monkepay.xyz";

const WALLET_CACHE_TTL_MS = 5 * 60 * 1000;
const WALLET_CACHE_MAX_ENTRIES = 1000;
const walletCache = new Map<string, WalletCacheEntry>();

export function getCachedWallet(cacheKey: string): WalletInfo | null {
  const entry = walletCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  const nowMs = Date.now();
  if (entry.expiresAtMs <= nowMs) {
    walletCache.delete(cacheKey);
    return null;
  }

  entry.lastAccessAtMs = nowMs;
  return entry.wallet;
}

export function upsertCachedWallet(cacheKey: string, wallet: WalletInfo): void {
  const nowMs = Date.now();

  walletCache.set(cacheKey, {
    wallet,
    expiresAtMs: nowMs + WALLET_CACHE_TTL_MS,
    lastAccessAtMs: nowMs,
  });

  if (walletCache.size <= WALLET_CACHE_MAX_ENTRIES) {
    return;
  }

  let evictionKey: string | null = null;
  let oldestAccessMs = Number.POSITIVE_INFINITY;

  for (const [key, entry] of walletCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      walletCache.delete(key);
      continue;
    }

    if (entry.lastAccessAtMs < oldestAccessMs) {
      oldestAccessMs = entry.lastAccessAtMs;
      evictionKey = key;
    }
  }

  if (walletCache.size > WALLET_CACHE_MAX_ENTRIES && evictionKey) {
    walletCache.delete(evictionKey);
  }
}

export function validateAndTrimAuth(auth: PaymentAuthOptions): {
  keyId: string;
  signingSecret: string;
  apiBase: string;
} {
  const keyId = auth.apiKeyId?.trim();
  const signingSecret = auth.apiKeySecret?.trim();
  const apiBase = auth.apiUrl?.trim() || DEFAULT_MONKEPAY_API;

  if (!keyId || !signingSecret) {
    throw new Error("apiKeyId and apiKeySecret are required");
  }

  return { keyId, signingSecret, apiBase };
}

// ── Signing ───────────────────────────────────────────────────────────────────

function buildHeaders(
  keyId: string,
  signingSecret: string,
  body: string,
): Record<string, string> {
  const timestamp = Date.now().toString()
  const nonce = randomUUID()
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex')

  return {
    'X-MonkePay-SDK': '0.1.0',
    'X-MonkePay-Timestamp': timestamp,
    'X-MonkePay-Signature': `sha256=${signature}`,
    'X-MonkePay-Key-Id': keyId,
    'X-MonkePay-Nonce': nonce,
  }
}

// ── Core request ──────────────────────────────────────────────────────────────

type ValidatedAuth = ReturnType<typeof validateAndTrimAuth>

export async function monkePayRequest<T>(
  path: string,
  method: 'GET' | 'POST',
  auth: ValidatedAuth,
  payload?: unknown,
  options?: {
    allow401?: boolean
    allow404?: boolean
    timeoutMs?: number
  },
): Promise<T | null> {
  // NOTE: body must be '' (empty string) for GET requests — never undefined or '{}'.
  // The backend HMAC verification uses the same convention. Diverging here will
  // silently break all GET request signatures.
  const body = payload ? JSON.stringify(payload) : ''
  const headers = buildHeaders(auth.keyId, auth.signingSecret, body)

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? 10_000,
  )

  let response: Response
  try {
    response = await fetch(`${auth.apiBase}${path}`, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(payload ? { body } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${options?.timeoutMs ?? 10_000}ms: ${path}`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (
    (options?.allow401 && response.status === 401) ||
    (options?.allow404 && response.status === 404)
  ) {
    return null
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Request failed (${response.status}): ${text}`)
  }

  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}
