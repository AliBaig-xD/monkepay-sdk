export function extractAgentAddress(header: string): string {
  try {
    const payload = decodePaymentHeader(header)
    const nestedAddress = findFirstStringByKeys(payload, [
      'from',
      'payer',
      'agentAddress',
      'address',
    ])
    return nestedAddress ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function extractSettledTxHash(header: string): string {
  try {
    const payload = decodePaymentResponseHeader(header)
    return findFirstStringByKeys(payload, [
      'transaction',
      'txHash',
      'transactionHash',
      'tx',
    ]) ?? ''
  } catch {
    return ''
  }
}

function decodePaymentHeader(header: string): Record<string, string> {
  const segment = header.split('.')[0] ?? ''
  if (!segment) {
    return {}
  }

  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = JSON.parse(atob(padded))
    return typeof decoded === 'object' && decoded !== null
      ? (decoded as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

function decodePaymentResponseHeader(header: string): Record<string, string> {
  if (!header) {
    return {}
  }

  try {
    const normalized = header.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

function findFirstStringByKeys(
  value: unknown,
  keys: string[],
  depth = 0,
): string | undefined {
  if ( depth >= 10 || !value || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>

  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate
    }
  }

  for (const nested of Object.values(record)) {
    const found = findFirstStringByKeys(nested, keys, depth + 1)
    if (found) {
      return found
    }
  }

  return undefined
}
