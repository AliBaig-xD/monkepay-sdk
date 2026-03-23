// packages/sdk/src/middleware/next.ts
//
// Next.js App Router adapter for MonkePay.
//
// Uses withX402 from x402-next (unscoped, v1.x) to wrap individual route handlers.
// This is intentionally NOT using paymentMiddleware/paymentProxy — those run in
// Edge runtime (no Node crypto for HMAC) and gate before the handler runs, which
// means they'd charge agents for handler errors. withX402 settles only after a
// successful handler response.
//
// Does NOT use runMonkePayCore — withX402 takes a completed handler callback,
// not a proceed() pattern. The orchestration is written directly here, reusing
// wallet.ts, errors.ts, and payment-headers.ts as building blocks.
//
// Usage:
//
//   // app/api/data/route.ts
//   const monkePay = MonkePayNext({
//     apiKeyId: process.env.MONKEPAY_KEY_ID!,
//     apiKeySecret: process.env.MONKEPAY_KEY_SECRET!,
//     price: '0.001',
//   })
//
//   export const GET = monkePay(async (req) => {
//     return NextResponse.json({ result: 'paid content' })
//   })
//
//   // Per-route price override
//   export const POST = monkePay(async (req) => {
//     return NextResponse.json({ result: 'paid content' })
//   }, { price: '0.005' })

import { withX402 } from "x402-next";
// NextRequest is type-only — no runtime import needed.
// NextResponse is a value import, left external via --external next in the build.
// Both resolve from the consumer's Next.js installation at runtime.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { type MonkePayMiddlewareState } from "./core.js";
import {
  emitOnErrorSafe,
  sanitizeErrorMessage,
  toPublicErrorResponse,
  createSdkError,
  MonkePaySdkError,
} from "../errors.js";
import { resolveWallet, recordPaymentEvent, verifyUnlockToken } from "../wallet.js";
import { extractAgentAddress, extractSettledTxHash } from "../payment-headers.js";
import type { MonkePayConfig, PaymentEvent } from "../types.js";

type NextRouteHandler = (req: NextRequest) => Promise<NextResponse>;
type MonkePayNextOverrides = Partial<Pick<MonkePayConfig, "price" | "paymentMode" | "unlockHeaderName">>;

// RouteWrapper: returned by MonkePayNext(instanceConfig).
// Call it with a handler (and optional per-route overrides) to produce a wrapped
// App Router export.
type MonkePayNextRouteWrapper = (
  handler: NextRouteHandler,
  overrides?: MonkePayNextOverrides,
) => NextRouteHandler;

// ── Config resolution ─────────────────────────────────────────────────────────

function resolveConfig(
  defaults: MonkePayConfig,
  overrides?: MonkePayNextOverrides,
): MonkePayConfig {
  const merged = { ...defaults, ...overrides };

  const apiKeyId = merged.apiKeyId?.trim();
  const apiKeySecret = merged.apiKeySecret?.trim();
  const price = merged.price?.trim();

  if (!apiKeyId) throw new Error("apiKeyId is required. Learn more at https://docs.monke.pay");
  if (!apiKeySecret) throw new Error("apiKeySecret is required. Learn more at https://docs.monke.pay");
  if (!price) throw new Error("price is required");

  return {
    apiKeyId,
    apiKeySecret,
    price,
    paymentMode: merged.paymentMode === "one_time" ? "one_time" : "per_request",
    unlockHeaderName: merged.unlockHeaderName?.trim() || "X-MonkePay-Unlock",
    // apiUrl, onPayment, onError are instance-level only — not overridable per route
    apiUrl: defaults.apiUrl,
    onPayment: defaults.onPayment,
    onError: defaults.onError,
  };
}

// ── Response cloning ──────────────────────────────────────────────────────────
//
// NextResponse headers are immutable — calling .headers.set() on the original
// silently fails. Clone when we need to inject the unlock token in one_time mode.

function cloneWithHeader(response: NextResponse, name: string, value: string): NextResponse {
  const cloned = new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
  cloned.headers.set(name, value);
  return cloned;
}

// ── Public error response ─────────────────────────────────────────────────────

function toErrorNextResponse(error: unknown): NextResponse {
  const { status, body } = toPublicErrorResponse(error);
  return NextResponse.json(body, { status });
}

// ── Core request handler ──────────────────────────────────────────────────────

type WrappedHandlerRef = {
  get: () => NextRouteHandler | null;
  set: (h: NextRouteHandler) => void;
};

async function handleRequest(
  req: NextRequest,
  handler: NextRouteHandler,
  config: MonkePayConfig,
  state: MonkePayMiddlewareState,
  normalizedPrice: string,
  routeConfig: { price: string; network: "base" | "base-sepolia" },
  wrappedHandlerRef: WrappedHandlerRef,
): Promise<NextResponse> {
  const paymentMode = config.paymentMode ?? "per_request";
  const unlockHeaderName = config.unlockHeaderName ?? "X-MonkePay-Unlock";
  const endpoint = new URL(req.url).pathname;

  try {
    // ── one_time: check unlock token before touching x402 ─────────────────────
    //
    // If the agent presents a valid unlock token, run the handler directly and
    // return — no payment required. Verification failures fall through to payment.
    if (paymentMode === "one_time") {
      const unlockToken = req.headers.get(unlockHeaderName) ?? "";

      if (unlockToken) {
        try {
          const verification = await verifyUnlockToken(
            { endpoint, token: unlockToken },
            { apiKeyId: config.apiKeyId, apiKeySecret: config.apiKeySecret, apiUrl: config.apiUrl },
          );

          if (verification.unlocked) {
            return await handler(req);
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
          // Fall through to x402 payment flow
        }
      }
    }

    // ── Wallet resolution ─────────────────────────────────────────────────────
    //
    // Resolve once on first request, cache on state. walletPromise deduplicates
    // concurrent cold-start requests — same pattern as core.ts.
    if (!state.payTo) {
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
        // Patch network into routeConfig now that we know it.
        // routeConfig is stable per wrap() call — safe to mutate once here.
        routeConfig.network = wallet.network;
      } catch (error) {
        await emitOnErrorSafe(config, {
          code: "WALLET_RESOLVE_FAILED",
          phase: "wallet_resolve",
          endpoint,
          paymentMode,
          recoverable: false,
          message: sanitizeErrorMessage(error, "Wallet resolution failed"),
          cause: error,
        });

        throw createSdkError({
          code: "WALLET_RESOLVE_FAILED",
          phase: "wallet_resolve",
          recoverable: false,
          cause: error,
        });
      }
    }

    // ── x402 payment gate ─────────────────────────────────────────────────────
    //
    // withX402 from x402-next@1.x takes a flat RouteConfig per call — not a
    // route map keyed by path (that's paymentMiddleware's shape).
    // Shape: { price: string, network: string, config?: { description? } }
    //
    // The wrapped handler is memoized in the wrap() closure via wrappedHandlerRef.
    // withX402 is only called once per route export, not on every request.

    // Capture X-Payment before withX402 runs — needed for agentAddress extraction
    const paymentHeader = req.headers.get("X-Payment") ?? "";

    // Lazily create the wrappedHandler on first request after wallet is known.
    if (!wrappedHandlerRef.get()) {
      wrappedHandlerRef.set(
        withX402(handler, state.payTo as `0x${string}`, routeConfig),
      );
    }

    let response: NextResponse;
    try {
      response = await wrappedHandlerRef.get()!(req);
    } catch (error) {
      await emitOnErrorSafe(config, {
        code: "PAYMENT_MIDDLEWARE_FAILED",
        phase: "x402",
        endpoint,
        paymentMode,
        recoverable: false,
        message: sanitizeErrorMessage(error, "Payment middleware failed"),
        cause: error,
      });

      throw createSdkError({
        code: "PAYMENT_MIDDLEWARE_FAILED",
        phase: "x402",
        recoverable: false,
        cause: error,
      });
    }

    // 4xx = no payment or payment rejected — return as-is, nothing to record
    if (response.status >= 400) {
      return response;
    }

    // ── Post-settlement: record event + fire callbacks ────────────────────────
    //
    // Payment settled on-chain. Record with backend, optionally inject unlock
    // token, then fire onPayment. All failures here are recoverable.
    const paymentResponseHeader = response.headers.get("X-PAYMENT-RESPONSE") ?? "";
    const resolvedTxHash = extractSettledTxHash(paymentResponseHeader);
    const paymentEvent: PaymentEvent = {
      agentAddress: extractAgentAddress(paymentHeader),
      amountUSDC: normalizedPrice.replace(/^\$/, ""),
      txHash: resolvedTxHash,
      timestamp: new Date(),
      endpoint,
    };

    try {
      if (!resolvedTxHash) {
        console.warn("[MonkePay] Missing canonical txHash in payment settlement; skipping backend event recording");
      } else {
        const eventResult = await recordPaymentEvent(
          {
            agentAddress: paymentEvent.agentAddress,
            amountUSDC: paymentEvent.amountUSDC,
            txHash: paymentEvent.txHash,
            endpoint: paymentEvent.endpoint,
          },
          { apiKeyId: config.apiKeyId, apiKeySecret: config.apiKeySecret, apiUrl: config.apiUrl },
        );

        // In one_time mode, inject the unlock token so the agent can persist it.
        // NextResponse is immutable — clone first.
        if (paymentMode === "one_time" && eventResult.unlockToken) {
          response = cloneWithHeader(response, unlockHeaderName, eventResult.unlockToken);
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

    if (config.onPayment && resolvedTxHash) {
      try {
        await config.onPayment(paymentEvent);
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

    return response;

  } catch (error) {
    // WALLET_RESOLVE_FAILED and PAYMENT_MIDDLEWARE_FAILED already emitted onError
    // before rethrowing as MonkePaySdkError. Guard prevents double-emit.
    if (!(error instanceof MonkePaySdkError)) {
      await emitOnErrorSafe(config, {
        code: "SDK_INTERNAL_ERROR",
        phase: "unknown",
        endpoint,
        paymentMode,
        recoverable: false,
        message: sanitizeErrorMessage(error, "MonkePay SDK internal error"),
        cause: error,
      });
    }

    return toErrorNextResponse(error);
  }
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * MonkePay middleware for Next.js App Router.
 *
 * Call once at module level (outside route handlers) to create a reusable wrapper.
 * Wallet resolution is cached on the instance — all routes using the same instance
 * share one resolved wallet address after the first request.
 *
 * Import from '@monkepay/sdk/next', not '@monkepay/sdk' — the Next adapter is
 * excluded from the main barrel to avoid loading next/server in non-Next runtimes.
 *
 * @example
 * import { MonkePayNext } from '@monkepay/sdk/next'
 *
 * const monkePay = MonkePayNext({
 *   apiKeyId: process.env.MONKEPAY_KEY_ID!,
 *   apiKeySecret: process.env.MONKEPAY_KEY_SECRET!,
 *   price: '0.001',
 * })
 *
 * export const GET = monkePay(async (req) => {
 *   return NextResponse.json({ result: 'paid content' })
 * })
 *
 * // Per-route price override — instance-level credentials/callbacks are preserved
 * export const POST = monkePay(async (req) => {
 *   return NextResponse.json({ result: 'paid content' })
 * }, { price: '0.005' })
 */
export function MonkePayNext(instanceConfig: MonkePayConfig): MonkePayNextRouteWrapper {
  // One shared state per MonkePayNext(...) call.
  // payTo/payNetwork populated on first wallet resolution, reused on all subsequent requests.
  const state: MonkePayMiddlewareState = {
    payTo: null,
    payNetwork: null,
    walletPromise: null,
  };

  return function wrap(handler: NextRouteHandler, overrides?: MonkePayNextOverrides): NextRouteHandler {
    const config = resolveConfig(instanceConfig, overrides);

    // Stable values computed once per wrap() call (i.e. once per route export).
    // normalizedPrice and routeConfig never change after this point.
    // routeConfig.network starts as 'base' and is patched once wallet resolves.
    const normalizedPrice = config.price.startsWith("$") ? config.price : `$${config.price}`;
    const routeConfig = { price: normalizedPrice, network: "base" as "base" | "base-sepolia" };

    // withX402 is called once after wallet resolution, then memoized here.
    // Avoids re-wrapping the handler on every request.
    let wrappedHandler: NextRouteHandler | null = null;
    const wrappedHandlerRef: WrappedHandlerRef = {
      get: () => wrappedHandler,
      set: (h) => { wrappedHandler = h; },
    };

    return async function monkePayHandler(req: NextRequest): Promise<NextResponse> {
      return handleRequest(req, handler, config, state, normalizedPrice, routeConfig, wrappedHandlerRef);
    };
  };
}