// packages/sdk/src/middleware/fastify.ts
//
// MonkePay Fastify adapter — standalone orchestration.
//
// Does NOT use runMonkePayCore. Fastify owns its request lifecycle via hooks;
// the proceed() pattern in core.ts is incompatible with that model. This file
// orchestrates directly using wallet.ts, errors.ts, and payment-headers.ts,
// the same approach taken by the Next.js adapter.
//
// Internal structure (mirrors future x402-fastify extraction boundary):
//
//   verifyPayment()        → pure x402: decode, verify, attach context
//   settlePayment()        → pure x402: settle, inject header
//   buildMonkePayPlugin()  → MonkePay: wallet resolution, event recording, callbacks
//
// Lifecycle:
//
//   preHandler hook  → verifyPayment → 402 on failure, attach ctx on success
//   onSend hook      → settlePayment → settle on-chain, inject X-PAYMENT-RESPONSE
//
// Usage:
//
//   const app = Fastify()
//   const monkePay = MonkePayFastify({ apiKeyId, apiKeySecret, price: '0.001' })
//
//   // Global — all routes at same price
//   app.register(monkePay())
//   app.get('/api/data', async () => ({ result: 'paid' }))
//
//   // Per-route pricing via setup() callback.
//   // Routes passed to setup() live in the same Fastify scope as the hooks,
//   // which is required for hook encapsulation to work correctly.
//   app.register(monkePay({
//     price: '0.001',
//     setup: (scope) => {
//       scope.get('/api/cheap', async () => ({ result: 'cheap' }))
//     }
//   }))
//
//   app.register(monkePay({
//     price: '0.10',
//     setup: (scope) => {
//       scope.get('/api/expensive', async () => ({ result: 'expensive' }))
//     }
//   }))

import {
  findMatchingPaymentRequirements,
  processPriceToAtomicAmount,
  toJsonSafe,
} from "x402/shared";
import { exact } from "x402/schemes";
import { SupportedEVMNetworks, SupportedSVMNetworks, settleResponseHeader } from "x402/types";
import { useFacilitator } from "x402/verify";
import {
  emitOnErrorSafe,
  sanitizeErrorMessage,
  toPublicErrorResponse,
  createSdkError,
} from "../errors.js";
import { resolveWallet, recordPaymentEvent, verifyUnlockToken } from "../wallet.js";
import { extractAgentAddress, extractSettledTxHash } from "../payment-headers.js";
import type { MonkePayConfig, SupportedNetwork, WalletInfo } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type HeaderValue = string | string[] | undefined;

type FastifyLikeRequest = {
  method: string;
  url: string;
  protocol?: string;
  headers: Record<string, HeaderValue>;
  raw: {
    method?: string;
    headers?: Record<string, HeaderValue>;
    path?: string;
    originalUrl?: string;
    protocol?: string;
  };
  _monkePayContext?: MonkePayRequestContext;
};

type FastifyLikeReply = {
  sent?: boolean;
  statusCode: number;
  code: (statusCode: number) => FastifyLikeReply;
  send: (payload?: unknown) => unknown;
  header: (name: string, value: string) => FastifyLikeReply;
  raw: {
    statusCode?: number;
    getHeader: (name: string) => unknown;
    setHeader: (name: string, value: string) => void;
  };
};

type FastifyDone = (err?: Error) => void;

type FastifyInstance = {
  addHook: (
    name: string,
    fn: (request: FastifyLikeRequest, reply: FastifyLikeReply, ...args: unknown[]) => Promise<unknown> | void,
  ) => void;
  // Route registration methods — available on scope inside setup()
  get: (path: string, handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => unknown) => void;
  post: (path: string, handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => unknown) => void;
  put: (path: string, handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => unknown) => void;
  patch: (path: string, handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => unknown) => void;
  delete: (path: string, handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => unknown) => void;
};

// Context attached to request by preHandler, consumed by onSend.
// bypassed: true means one_time unlock token was valid — onSend skips settlement.
type MonkePayRequestContext =
  | { bypassed: true }
  | {
      bypassed: false;
      decodedPayment: unknown;
      selectedRequirements: unknown;
      paymentRequirements: unknown[];
      x402Version: number;
      paymentHeader: string;
      normalizedPrice: string;
      endpoint: string;
    };

// Shared wallet state per MonkePayFastify() instance
type WalletState = {
  payTo: string | null;
  payNetwork: SupportedNetwork | null;
  walletPromise: Promise<WalletInfo> | null;
};

// setup() receives the scoped Fastify instance so routes registered inside it
// share the same scope as the MonkePay hooks. This is required for per-route
// pricing — hooks only fire on routes in the same scope or a child scope.
type MonkePayFastifyOverrides = Partial<MonkePayConfig> & {
  setup?: (scope: FastifyInstance) => void;
};
type MonkePayFastifyPlugin = (instance: FastifyInstance, opts: unknown, done: FastifyDone) => void;
type MonkePayFastifyInstance = (overrides?: MonkePayFastifyOverrides) => MonkePayFastifyPlugin;

// ── Helpers ───────────────────────────────────────────────────────────────────

function asSingleHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readHeader(request: FastifyLikeRequest, name: string): string | undefined {
  return asSingleHeaderValue(request.headers[name.toLowerCase()]);
}

function requestPath(request: FastifyLikeRequest): string {
  return request.url.split("?")[0] || "/";
}

function send402(
  reply: FastifyLikeReply,
  x402Version: number,
  error: string,
  paymentRequirements: unknown[],
  extra?: Record<string, unknown>,
): void {
  reply.code(402).send({
    x402Version,
    error,
    accepts: toJsonSafe(paymentRequirements),
    ...extra,
  });
}

// ── Wallet resolution ─────────────────────────────────────────────────────────
//
// Resolves once per WalletState instance, deduplicates concurrent cold-start
// requests via walletPromise. Same pattern as Next.js adapter.

async function resolveWalletCached(
  state: WalletState,
  config: MonkePayConfig,
  endpoint: string,
  paymentMode: "per_request" | "one_time",
): Promise<void> {
  if (state.payTo) return;

  if (!state.walletPromise) {
    state.walletPromise = resolveWallet({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
      apiUrl: config.apiUrl,
    }).catch((error) => {
      state.walletPromise = null;
      throw error;
    });
  }

  try {
    const wallet = await state.walletPromise;
    state.payTo = wallet.address;
    state.payNetwork = wallet.network;
  } catch (error) {
    await emitOnErrorSafe(config, {
      code: "WALLET_RESOLVE_FAILED",
      phase: "wallet_resolve",
      endpoint,
      paymentMode,
      recoverable: true, // transient — walletPromise is nulled so next request retries
      message: sanitizeErrorMessage(error, "Wallet resolution failed"),
      cause: error,
    });

    throw createSdkError({
      code: "WALLET_RESOLVE_FAILED",
      phase: "wallet_resolve",
      recoverable: true,
      cause: error,
    });
  }
}

// ── Build payment requirements ────────────────────────────────────────────────
//
// Pure x402 — no MonkePay dependencies. Future extraction point for x402-fastify.

async function buildPaymentRequirements(
  request: FastifyLikeRequest,
  payTo: string,
  price: string,
  network: string,
  baseUrl?: string,
): Promise<unknown[]> {
  const { supported } = useFacilitator();

  const atomicAmountForAsset = processPriceToAtomicAmount(price as any, network as any);
  if ("error" in atomicAmountForAsset) {
    throw new Error(atomicAmountForAsset.error);
  }

  const { maxAmountRequired, asset } = atomicAmountForAsset;

  // Resource URL resolution order:
  // 1. config.baseUrl
  // 2. X-Forwarded-Proto header
  // 3. request.protocol / request.raw.protocol
  // 4. 'http' (last resort)
  const host = readHeader(request, "host") ?? "localhost";
  const forwardedProto = readHeader(request, "x-forwarded-proto");
  const protocol = forwardedProto ?? request.protocol ?? request.raw.protocol ?? "http";
  const base = baseUrl ? baseUrl.replace(/\/$/, "") : `${protocol}://${host}`;
  const resourceUrl = `${base}${requestPath(request)}`;

  const paymentRequirements: unknown[] = [];

  // Intentional cast: SupportedEVMNetworks/SupportedSVMNetworks are const tuples, not string[].
  // Safe at runtime; TypeScript catches any x402 export shape changes at import time.
  if ((SupportedEVMNetworks as readonly string[]).includes(network)) {
    paymentRequirements.push({
      scheme: "exact",
      network,
      maxAmountRequired,
      resource: resourceUrl,
      description: "",
      mimeType: "",
      payTo,
      maxTimeoutSeconds: 60,
      asset: String((asset as { address: string }).address),
      outputSchema: {
        input: {
          type: "http",
          method: request.method.toUpperCase(),
          discoverable: true,
        },
        output: undefined,
      },
      extra: (asset as { eip712?: Record<string, unknown> }).eip712,
    });
  } else if ((SupportedSVMNetworks as readonly string[]).includes(network)) {
    const paymentKinds = await supported();
    let feePayer: string | undefined;
    for (const kind of paymentKinds.kinds) {
      if (kind.network === network && kind.scheme === "exact") {
        feePayer = (kind.extra as { feePayer?: string } | undefined)?.feePayer;
        break;
      }
    }
    if (!feePayer) {
      throw new Error(`Facilitator did not provide a fee payer for network: ${network}`);
    }

    paymentRequirements.push({
      scheme: "exact",
      network,
      maxAmountRequired,
      resource: resourceUrl,
      description: "",
      mimeType: "",
      payTo,
      maxTimeoutSeconds: 60,
      asset: String((asset as { address: string }).address),
      outputSchema: {
        input: {
          type: "http",
          method: request.method.toUpperCase(),
          discoverable: true,
        },
        output: undefined,
      },
      extra: { feePayer },
    });
  } else {
    throw new Error(`Unsupported network: ${network}`);
  }

  return paymentRequirements;
}

// ── verifyPayment (preHandler) ────────────────────────────────────────────────
//
// Pure x402 verification. No settlement, no on-chain calls.
// On success: attaches MonkePayRequestContext to request._monkePayContext.
// On failure: sends 402 and returns — Fastify stops lifecycle automatically
//             because reply.sent is true when the async hook resolves.

async function verifyPayment(
  request: FastifyLikeRequest,
  reply: FastifyLikeReply,
  config: MonkePayConfig,
  state: WalletState,
): Promise<void> {
  const paymentMode = config.paymentMode ?? "per_request";
  const unlockHeaderName = config.unlockHeaderName ?? "X-MonkePay-Unlock";
  const endpoint = requestPath(request);

  // ── one_time unlock check ─────────────────────────────────────────────────
  if (paymentMode === "one_time") {
    const unlockToken = readHeader(request, unlockHeaderName) ?? "";

    if (unlockToken) {
      try {
        const verification = await verifyUnlockToken(
          { endpoint, token: unlockToken },
          { apiKeyId: config.apiKeyId, apiKeySecret: config.apiKeySecret, apiUrl: config.apiUrl },
        );

        if (verification.unlocked) {
          request._monkePayContext = { bypassed: true };
          return;
        }
      } catch (error) {
        await emitOnErrorSafe(config, {
          code: "UNLOCK_VERIFY_FAILED",
          phase: "unlock_verify",
          endpoint,
          paymentMode,
          recoverable: true,
          message: sanitizeErrorMessage(error, "Unlock token verification failed"),
          cause: error,
        });
        console.warn("[MonkePay] Failed to verify unlock token", sanitizeErrorMessage(error, "unknown error"));
        // Fall through to payment
      }
    }
  }

  // ── Wallet resolution ─────────────────────────────────────────────────────
  try {
    await resolveWalletCached(state, config, endpoint, paymentMode);
  } catch (error) {
    // emitOnErrorSafe already called inside resolveWalletCached
    const { status, body } = toPublicErrorResponse(error);
    reply.code(status).send(body);
    return;
  }

  const normalizedPrice = config.price.startsWith("$") ? config.price : `$${config.price}`;

  // ── Build payment requirements ────────────────────────────────────────────
  let paymentRequirements: unknown[];
  try {
    paymentRequirements = await buildPaymentRequirements(
      request,
      state.payTo as string,
      normalizedPrice,
      state.payNetwork ?? "base",
      config.baseUrl,
    );
  } catch (error) {
    await emitOnErrorSafe(config, {
      code: "PAYMENT_MIDDLEWARE_FAILED",
      phase: "x402",
      endpoint,
      paymentMode,
      recoverable: false,
      message: sanitizeErrorMessage(error, "Failed to build payment requirements"),
      cause: error,
    });
    const { status, body } = toPublicErrorResponse(
      createSdkError({ code: "PAYMENT_MIDDLEWARE_FAILED", phase: "x402", recoverable: false, cause: error }),
    );
    reply.code(status).send(body);
    return;
  }

  const x402Version = 1;

  // ── Check X-Payment header ────────────────────────────────────────────────
  const paymentHeader = readHeader(request, "x-payment") ?? "";
  if (!paymentHeader) {
    send402(reply, x402Version, "X-PAYMENT header is required", paymentRequirements);
    return;
  }

  // ── Decode payment ────────────────────────────────────────────────────────
  // Always EVM decode: MonkePay wallets are Base/Base Sepolia only, so
  // state.payNetwork is always an EVM network. The legacy x402 package's
  // exact.svm does not expose decodePayment — SVM support would require
  // migrating to @x402/svm which is a separate package. See roadmap.
  let decodedPayment: any;
  try {
    decodedPayment = exact.evm.decodePayment(paymentHeader);
    decodedPayment.x402Version = x402Version;
  } catch (error) {
    send402(
      reply,
      x402Version,
      error instanceof Error ? error.message : "Invalid or malformed payment header",
      paymentRequirements,
    );
    return;
  }

  // ── Match requirements ────────────────────────────────────────────────────
  const selectedRequirements = findMatchingPaymentRequirements(paymentRequirements as any, decodedPayment);
  if (!selectedRequirements) {
    send402(reply, x402Version, "Unable to find matching payment requirements", paymentRequirements);
    return;
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  const { verify } = useFacilitator();
  let verifyResponse: Awaited<ReturnType<typeof verify>>;
  try {
    verifyResponse = await verify(decodedPayment, selectedRequirements);
  } catch (error) {
    send402(
      reply,
      x402Version,
      error instanceof Error ? error.message : "Payment verification failed",
      paymentRequirements,
    );
    return;
  }

  if (!verifyResponse.isValid) {
    send402(reply, x402Version, verifyResponse.invalidReason ?? "Payment invalid", paymentRequirements, {
      payer: verifyResponse.payer,
    });
    return;
  }

  // ── Attach context for onSend ─────────────────────────────────────────────
  request._monkePayContext = {
    bypassed: false,
    decodedPayment,
    selectedRequirements,
    paymentRequirements,
    x402Version,
    paymentHeader,
    normalizedPrice,
    endpoint,
  };
}

// ── settlePayment (onSend) ────────────────────────────────────────────────────
//
// Runs after handler, before response is sent. Settles payment on-chain,
// injects X-PAYMENT-RESPONSE, records event, fires onPayment callback.

async function settlePayment(
  request: FastifyLikeRequest,
  reply: FastifyLikeReply,
  payload: unknown,
  config: MonkePayConfig,
): Promise<unknown> {
  const ctx = request._monkePayContext;

  // No context = route wasn't metered, or preHandler already sent 402
  if (!ctx) return payload;

  // Unlock bypass — handler ran without payment, nothing to settle
  if (ctx.bypassed) return payload;

  // Handler responded with an error — don't settle
  if (reply.statusCode >= 400) return payload;

  const { settle } = useFacilitator();
  const {
    decodedPayment,
    selectedRequirements,
    paymentRequirements,
    x402Version,
    paymentHeader,
    normalizedPrice,
    endpoint,
  } = ctx;

  const paymentMode = config.paymentMode ?? "per_request";
  const unlockHeaderName = config.unlockHeaderName ?? "X-MonkePay-Unlock";

  // ── Settle on-chain ───────────────────────────────────────────────────────
  let settleResponse: Awaited<ReturnType<typeof settle>>;
  try {
    settleResponse = await settle(decodedPayment as any, selectedRequirements as any);
  } catch (error) {
    reply.code(402).header("Content-Type", "application/json");
    return JSON.stringify({
      x402Version,
      error: error instanceof Error ? error.message : "Payment settlement failed",
      accepts: toJsonSafe(paymentRequirements as any),
    });
  }

  if (!settleResponse.success) {
    reply.code(402).header("Content-Type", "application/json");
    return JSON.stringify({
      x402Version,
      error: settleResponse.errorReason,
      accepts: toJsonSafe(paymentRequirements as any),
    });
  }

  // ── Inject settlement header ──────────────────────────────────────────────
  const responseHeader = settleResponseHeader(settleResponse);
  reply.header("X-PAYMENT-RESPONSE", responseHeader);

  // ── Record payment event ──────────────────────────────────────────────────
  const resolvedTxHash = extractSettledTxHash(responseHeader);
  const agentAddress = extractAgentAddress(paymentHeader);
  const amountUSDC = normalizedPrice.replace(/^\$/, ""); // strip leading $ once, reuse below

  try {
    if (!resolvedTxHash) {
      console.warn("[MonkePay] Missing canonical txHash in settlement; skipping event recording");
    } else {
      const eventResult = await recordPaymentEvent(
        {
          agentAddress,
          amountUSDC,
          txHash: resolvedTxHash,
          endpoint,
        },
        { apiKeyId: config.apiKeyId, apiKeySecret: config.apiKeySecret, apiUrl: config.apiUrl },
      );

      // one_time: inject unlock token so agent can persist it
      if (paymentMode === "one_time" && eventResult.unlockToken) {
        reply.header(unlockHeaderName, eventResult.unlockToken);
      }
    }
  } catch (error) {
    await emitOnErrorSafe(config, {
      code: "EVENT_RECORD_FAILED",
      phase: "event_record",
      endpoint,
      paymentMode,
      recoverable: true,
      txHash: resolvedTxHash || undefined,
      message: sanitizeErrorMessage(error, "Payment event recording failed"),
      cause: error,
    });
    console.warn("[MonkePay] Failed to record payment event", sanitizeErrorMessage(error, "unknown error"));
  }

  // ── onPayment callback ────────────────────────────────────────────────────
  if (config.onPayment && resolvedTxHash) {
    try {
      await config.onPayment({
        agentAddress,
        amountUSDC,
        txHash: resolvedTxHash,
        timestamp: new Date(),
        endpoint,
      });
    } catch (error) {
      await emitOnErrorSafe(config, {
        code: "ON_PAYMENT_CALLBACK_FAILED",
        phase: "onPayment",
        endpoint,
        paymentMode,
        recoverable: true,
        txHash: resolvedTxHash || undefined,
        message: sanitizeErrorMessage(error, "onPayment callback failed"),
        cause: error,
      });
      console.warn("[MonkePay] onPayment callback failed", sanitizeErrorMessage(error, "unknown error"));
    }
  }

  return payload;
}

// ── Plugin builder ────────────────────────────────────────────────────────────

function buildMonkePayPlugin(
  config: MonkePayConfig,
  setup?: (scope: FastifyInstance) => void,
): MonkePayFastifyPlugin {
  // One wallet state per plugin instance — shared across all requests on this
  // plugin. Each monkePay() call gets its own state, so scoped plugins are isolated.
  const state: WalletState = {
    payTo: null,
    payNetwork: null,
    walletPromise: null,
  };

  return (instance: FastifyInstance, _opts: unknown, done: FastifyDone) => {
    instance.addHook("preHandler", async (request: FastifyLikeRequest, reply: FastifyLikeReply) => {
      try {
        await verifyPayment(request, reply, config, state);
        // No hijack needed. verifyPayment sends 402 and returns on failure.
        // Fastify detects reply.sent === true when the async hook resolves and
        // naturally skips the route handler. No manual lifecycle management needed.
      } catch (error) {
        // Unexpected throw outside verifyPayment's own try/catch blocks.
        // Fire onError so it's observable, then fail closed with 500.
        await emitOnErrorSafe(config, {
          code: "SDK_INTERNAL_ERROR",
          phase: "x402",
          endpoint: request.url?.split("?")[0] ?? "/",
          paymentMode: config.paymentMode ?? "per_request",
          recoverable: false,
          message: sanitizeErrorMessage(error, "Unexpected error in preHandler"),
          cause: error,
        });
        if (!reply.sent) {
          reply.code(500).send({ error: { code: "SDK_INTERNAL_ERROR", message: "Internal SDK error" } });
        }
      }
    });

    instance.addHook("onSend", async (request: FastifyLikeRequest, reply: FastifyLikeReply, payload: unknown) => {
      try {
        return await settlePayment(request, reply, payload, config);
      } catch (error) {
        // Unexpected throw outside settlePayment's own try/catch blocks.
        await emitOnErrorSafe(config, {
          code: "SDK_INTERNAL_ERROR",
          phase: "x402",
          endpoint: request.url?.split("?")[0] ?? "/",
          paymentMode: config.paymentMode ?? "per_request",
          recoverable: false,
          message: sanitizeErrorMessage(error, "Unexpected error in onSend"),
          cause: error,
        });
        return payload; // return original payload — don't swallow the response
      }
    });

    // Routes registered via setup() live in the same scope as the hooks above,
    // so they are guaranteed to be gated. This is the only reliable per-route
    // isolation pattern in Fastify — hooks only fire on routes in the same
    // scope or a child scope, never on sibling or parent scopes.
    if (setup) setup(instance);

    done();
  };
}

// ── Config resolution ─────────────────────────────────────────────────────────

function resolveConfig(
  defaults: MonkePayFastifyOverrides,
  overrides?: MonkePayFastifyOverrides,
): { config: MonkePayConfig; setup?: (scope: FastifyInstance) => void } {
  const merged = { ...defaults, ...overrides } as MonkePayFastifyOverrides;

  const apiKeyId = merged.apiKeyId?.trim();
  const apiKeySecret = merged.apiKeySecret?.trim();
  const price = merged.price?.trim();

  if (!apiKeyId) throw new Error("apiKeyId is required. Learn more at https://docs.monke.pay");
  if (!apiKeySecret) throw new Error("apiKeySecret is required. Learn more at https://docs.monke.pay");
  if (!price) throw new Error("price is required");

  return {
    config: {
      apiKeyId,
      apiKeySecret,
      price,
      paymentMode: merged.paymentMode === "one_time" ? "one_time" : "per_request",
      unlockHeaderName: merged.unlockHeaderName?.trim() || "X-MonkePay-Unlock",
      apiUrl: merged.apiUrl?.trim(),
      baseUrl: merged.baseUrl?.trim(),
      onPayment: merged.onPayment,
      onError: merged.onError,
    },
    setup: merged.setup,
  };
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * MonkePay middleware for Fastify.
 *
 * Returns a factory. Call it (with optional per-route overrides) to get a
 * Fastify plugin, then register with `app.register()`.
 *
 * Wallet resolution is cached per factory instance — all routes sharing the
 * same `MonkePayFastify(...)` call share one resolved wallet after first request.
 *
 * @example
 * const monkePay = MonkePayFastify({
 *   apiKeyId: process.env.MONKEPAY_KEY_ID!,
 *   apiKeySecret: process.env.MONKEPAY_KEY_SECRET!,
 *   price: '0.001',
 * })
 *
 * // All routes must be registered via setup() — routes added at the app level
 * // after register() are in a parent scope and will NOT be gated.
 *
 * // Per-route pricing via setup():
 * app.register(monkePay({
 *   price: '0.001',
 *   setup: (scope) => {
 *     scope.get('/api/cheap', async () => ({ result: 'cheap' }))
 *   }
 * }))
 *
 * app.register(monkePay({
 *   price: '0.10',
 *   setup: (scope) => {
 *     scope.get('/api/expensive', async () => ({ result: 'expensive' }))
 *   }
 * }))
 */
export function MonkePayFastify(
  defaults: MonkePayConfig | MonkePayFastifyOverrides,
): MonkePayFastifyInstance {
  return (overrides?: MonkePayFastifyOverrides): MonkePayFastifyPlugin => {
    const { config, setup } = resolveConfig(defaults, overrides);
    return buildMonkePayPlugin(config, setup);
  };
}