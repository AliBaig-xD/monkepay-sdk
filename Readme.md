# MonkePay SDK

MonkePay lets you gate any API endpoint behind per-request USDC payments using the [x402 protocol](https://x402.org). Agents pay autonomously — no accounts, no KYC, no bank.

Works with Hono, Express, Fastify, and Next.js App Router.

**Docs:** [docs.monkepay.xyz](https://docs.monkepay.xyz) — setup, API keys, dashboard.

---

## Install

```bash
npm install @monkepay/sdk
```

---

## Quick start

### Hono

```ts
import { Hono } from 'hono'
import { MonkePayHono } from '@monkepay/sdk/hono'

const app = new Hono()

const monkePay = MonkePayHono({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
})

app.use('/api/*', monkePay)

app.get('/api/data', (c) => c.json({ result: 'paid content' }))
```

### Express

```ts
import express from 'express'
import { MonkePayExpress } from '@monkepay/sdk/express'

const app = express()

const monkePay = MonkePayExpress({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
})

app.get('/api/data', monkePay, (req, res) => {
  res.json({ result: 'paid content' })
})
```

### Fastify

```ts
import Fastify from 'fastify'
import { MonkePayFastify } from '@monkepay/sdk/fastify'

const app = Fastify()

const monkePay = MonkePayFastify({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
})

app.register(monkePay({
  setup: (scope) => {
    scope.get('/api/data', async () => ({ result: 'paid content' }))
  },
}))

app.listen({ port: 3000 })
```

### Next.js (App Router)

```ts
// app/api/data/route.ts
import { MonkePayNext } from '@monkepay/sdk/next'
import { NextResponse } from 'next/server'

const monkePay = MonkePayNext({
  apiKeyId: process.env.MONKEPAY_KEY_ID!,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET!,
  price: '0.001',
})

export const GET = monkePay(async () => {
  return NextResponse.json({ result: 'paid content' })
})
```

---

## Config reference

| Parameter | Required | Default | Description |
|---|---|---|---|
| `apiKeyId` | ✅ | — | Your MonkePay API key ID |
| `apiKeySecret` | ✅ | — | Your MonkePay API key secret |
| `price` | ✅ | — | Price per request in USDC, e.g. `'0.001'`. The `$` prefix is optional. |
| `paymentMode` | — | `'per_request'` | `'per_request'` or `'one_time'`. See [Payment modes](#payment-modes). |
| `unlockHeaderName` | — | `'X-MonkePay-Unlock'` | Header used to pass the one-time unlock token. Only relevant in `one_time` mode. |
| `baseUrl` | — | — | Your API's public base URL, e.g. `'https://api.yourcompany.com'`. Fastify only — required when running behind a reverse proxy. See [Reverse proxies](#reverse-proxies). |
| `onPayment` | — | — | Callback fired after each successful payment. See [onPayment](#onpayment). |
| `onError` | — | — | Callback fired on internal SDK errors. See [Error handling](#error-handling). |

---

## Payment modes

### `per_request` (default)

Every request requires a valid payment. The agent pays on each call.

```
Agent → GET /api/data (no payment)
← 402 { accepts: [...payment requirements] }

Agent → GET /api/data (X-PAYMENT: ...)
← 200 { result: '...' }
  X-PAYMENT-RESPONSE: ...  ← settlement proof
```

### `one_time`

The agent pays once and receives an unlock token. That token grants **permanent access** — subsequent requests with the token bypass payment entirely, indefinitely.

```
Agent → GET /api/data (no token, no payment)
← 402 { accepts: [...payment requirements] }

Agent → GET /api/data (X-PAYMENT: ...)
← 200 { result: '...' }
  X-MonkePay-Unlock: <token>   ← agent must persist this

Agent → GET /api/data (X-MonkePay-Unlock: <token>)
← 200 { result: '...' }   ← no payment needed, works permanently
```

```ts
const monkePay = MonkePayHono({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.10',
  paymentMode: 'one_time',
})
```

**Important — token behavior:**

- The token is tied to the token string, not the agent's wallet address. Any agent instance that holds the token gets access; one without it must pay.
- **The agent is responsible for persisting the token.** Lost token = pay again for a new one.
- Tokens are scoped to the endpoint they were issued for — a token for `/api/data` does not unlock `/api/other`.
- There is currently no expiry — access is permanent once granted. Time-limited and subscription access are [planned](#roadmap).

---

## Per-route overrides

All adapters support per-route price and mode overrides. Set defaults at the instance level and override per route.

### Hono

```ts
const monkePay = MonkePayHono({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
})

app.use('/api/cheap', monkePay({ price: '0.001' }))
app.use('/api/expensive', monkePay({ price: '0.10' }))
app.use('/api/unlock', monkePay({ price: '1.00', paymentMode: 'one_time' }))
```

### Express

```ts
const monkePay = MonkePayExpress({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
})

app.get('/api/cheap', monkePay({ price: '0.001' }), handler)
app.get('/api/expensive', monkePay({ price: '0.10' }), handler)
app.get('/api/unlock', monkePay({ price: '1.00', paymentMode: 'one_time' }), handler)
```

### Fastify

Fastify hook encapsulation requires routes to be registered in the same scope as the hooks. Pass routes via the `setup` callback — MonkePay registers the hooks first, then calls `setup(scope)` so your routes share the same scope:

```ts
const monkePay = MonkePayFastify({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
})

// $0.001 routes
app.register(monkePay({
  price: '0.001',
  setup: (scope) => {
    scope.get('/api/cheap', async () => ({ result: 'cheap' }))
  },
}))

// $0.10 routes
app.register(monkePay({
  price: '0.10',
  setup: (scope) => {
    scope.get('/api/expensive', async () => ({ result: 'expensive' }))
  },
}))

// One-time unlock
app.register(monkePay({
  price: '1.00',
  paymentMode: 'one_time',
  setup: (scope) => {
    scope.get('/api/unlock', async () => ({ result: 'unlocked' }))
  },
}))
```

> **Why `setup()`?** Fastify hooks only fire on routes registered in the same scope or a child scope. Routes registered outside the plugin (at the parent `app` level) are in a parent scope and won't see the hooks. The `setup` callback is the correct pattern for per-route pricing in Fastify.

### Next.js

```ts
const monkePay = MonkePayNext({
  apiKeyId: process.env.MONKEPAY_KEY_ID!,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET!,
  price: '0.001',
})

export const GET = monkePay(async () => NextResponse.json({ result: 'cheap' }))
export const POST = monkePay(async () => NextResponse.json({ result: 'expensive' }), { price: '0.10' })
```

---

## Reverse proxies

When your API runs behind a reverse proxy (Railway, Render, Fly, Cloudflare, Nginx), the SDK needs to know your public-facing URL to construct the x402 resource URL correctly. Without it, agents may receive `http://` resource URLs when your API is actually `https://`.

**Fastify** requires `baseUrl` explicitly when running behind a proxy:

```ts
const monkePay = MonkePayFastify({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
  baseUrl: 'https://api.yourcompany.com',
})
```

Fastify also reads `X-Forwarded-Proto` as a fallback. Resource URL resolution order:

1. `baseUrl` config (highest priority)
2. `X-Forwarded-Proto` request header
3. `request.protocol`
4. `'http'` (last resort)

**Hono and Express** delegate resource URL construction to `x402-hono` / `x402-express` internally. Configure proxy trust in the framework itself:

```ts
// Express
app.set('trust proxy', 1)

// Hono — handles this automatically in most runtimes
```

---

## Adapter-specific notes

### Fastify

MonkePay registers two Fastify hooks internally: `preHandler` for payment verification and `onSend` for settlement. This is the correct Fastify lifecycle for payment gating — verification happens before the handler runs, settlement happens after the handler responds but before the response is sent.

**Use `app.register(monkePay())` not `preHandler`.** The adapter must be registered as a plugin to add its hooks correctly.

**No streaming on payment-gated routes.** Settlement happens in `onSend` which requires the full response to be available. Streaming endpoints (`reply.raw.write` loops, SSE) are not supported on payment-gated routes.

### Next.js

**App Router only** — Pages Router is not supported. Use `MonkePayNext` in `app/api/` route files only.

**Do not use `paymentMiddleware` or `middleware.ts`** — those run in the Edge runtime which has no Node crypto for HMAC signing. `MonkePayNext` uses `withX402` in route handlers which run in the Node.js runtime.

**No streaming** — same constraint as Fastify.

**Import from `@monkepay/sdk/next`**, not `@monkepay/sdk`. The Next adapter is excluded from the main barrel to avoid loading `next/server` in non-Next runtimes.

### Express

If an internal SDK error occurs after response headers have already been sent, the SDK calls `next(error)` to hand off to Express's error handler. Register an error handler:

```ts
app.use((err, req, res, next) => {
  console.error(err)
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' })
  }
})
```

### Hono

Works out of the box. The `baseUrl` config is accepted but currently has no effect — resource URL construction is handled by `x402-hono` internally.

---

## onPayment

Fires after every successful payment settlement. Use it for usage tracking, webhooks, or business logic tied to payment events.

```ts
const monkePay = MonkePayHono({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
  onPayment: async (payment) => {
    console.log(`Payment from ${payment.agentAddress}: ${payment.amountUSDC} USDC`)
    console.log(`Tx: ${payment.txHash} on ${payment.endpoint}`)
    await db.insert({ ...payment })
  },
})
```

`onPayment` receives a `PaymentEvent`:

```ts
interface PaymentEvent {
  agentAddress: string   // agent's wallet address
  amountUSDC: string     // amount paid, e.g. '0.001'
  txHash: string         // on-chain transaction hash
  timestamp: Date
  endpoint: string       // request path, e.g. '/api/data'
}
```

`onPayment` errors are caught and logged — they never surface to the agent or interrupt the response.

---

## Error handling

```ts
const monkePay = MonkePayHono({
  apiKeyId: process.env.MONKEPAY_KEY_ID,
  apiKeySecret: process.env.MONKEPAY_KEY_SECRET,
  price: '0.001',
  onError: async (error) => {
    console.error(`[MonkePay] ${error.code} in ${error.phase}`, {
      endpoint: error.endpoint,
      recoverable: error.recoverable,
      message: error.message,
    })
    await alerting.notify(error)
  },
})
```

`onError` receives a `MonkePayErrorContext`:

```ts
interface MonkePayErrorContext {
  code: MonkePayErrorCode
  phase: MonkePayErrorPhase
  endpoint: string
  paymentMode: 'per_request' | 'one_time'
  recoverable: boolean
  message: string
  requestId?: string
  txHash?: string
  statusCode?: number
  cause?: unknown
}
```

### Error codes

| Code | Status | Recoverable | Description |
|---|---|---|---|
| `INVALID_CONFIG` | 500 | No | SDK misconfigured — missing required params |
| `WALLET_RESOLVE_FAILED` | 502 | Yes | Could not resolve payout wallet from API credentials — retried on next request |
| `UNLOCK_VERIFY_FAILED` | 402 | Yes | Unlock token invalid or verification failed — falls through to payment, agent receives standard 402 |
| `PAYMENT_MIDDLEWARE_FAILED` | 502 | No | x402 payment validation threw unexpectedly |
| `EVENT_RECORD_FAILED` | — | Yes | Payment settled on-chain but backend failed to log it — agent still gets 200 |
| `ON_PAYMENT_CALLBACK_FAILED` | — | Yes | `onPayment` callback threw — response unaffected |
| `SDK_INTERNAL_ERROR` | 500 | No | Unexpected internal error |

Recoverable errors fire `onError` but do not interrupt the request. Non-recoverable errors return an error response to the agent.

---

## Networks

- `base` — Base mainnet (production)
- `base-sepolia` — Base Sepolia testnet (development)

The network is determined by your registered wallet on the MonkePay dashboard. No config needed in the SDK.

---

## Roadmap

**Access models**

- **Token expiry** — `one_time` tokens that expire after a configurable duration
- **Subscription mode** — wallet-scoped recurring access, pay once per period
- **Credit pack mode** — pay for N requests upfront, consumed across agent instances
- **Perpetual unlock (wallet-scoped)** — like `one_time` but tied to wallet address, not token string

**SDK**

- `baseUrl` support for Hono and Express adapters
- Streaming support for Next.js payment-gated routes