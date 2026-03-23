// packages/sdk/src/middleware/hono.ts

import { paymentMiddleware } from "x402-hono";
import { runMonkePayCore, type MonkePayMiddlewareState } from "./core.js";
import type { MonkePayConfig } from "../types.js";
import type { Context, Next } from "hono";

type MonkePayHonoMiddleware = (c: Context, next: Next) => Promise<unknown>;
type MonkePayHonoOverrides = Partial<MonkePayConfig>;
type MonkePayHonoInstance = {
  (c: Context, next: Next): Promise<unknown>;
  (overrides: MonkePayHonoOverrides): MonkePayHonoMiddleware;
};

function buildMonkePayHono(config: MonkePayConfig): MonkePayHonoMiddleware {
  const state: MonkePayMiddlewareState = {
    payTo: null,
    payNetwork: null,
    walletPromise: null,
  };

  const resolveResponse = (c: Context, x402Result: unknown): Response =>
    x402Result instanceof Response ? x402Result : c.res;

  return async (c: Context, next: Next) => {
    return runMonkePayCore(c, async () => {
      await next();
    }, config, state, {
      getPath: (ctx) => ctx.req.path,
      getHeader: (ctx, name) => ctx.req.header(name) ?? undefined,
      runX402: async (ctx, payTo, routes, proceed) => {
        const x402 = paymentMiddleware(payTo as `0x${string}`, routes);
        return await x402(ctx, async () => {
          await proceed();
        });
      },
      getStatus: (ctx, x402Result) => resolveResponse(ctx, x402Result).status,
      getPaymentResponseHeader: (ctx, x402Result) =>
        resolveResponse(ctx, x402Result).headers.get("X-PAYMENT-RESPONSE") ?? "",
      setHeader: (ctx, x402Result, name, value) => {
        resolveResponse(ctx, x402Result).headers.set(name, value);
      },
      onUnlockedBypass: async (ctx) => ctx.res,
      finalizeFromX402: (ctx, x402Result) => resolveResponse(ctx, x402Result),
      onPublicError: (ctx, publicError) => {
        ctx.status(publicError.status);
        return ctx.json(publicError.body);
      },
    });
  };
}

export function MonkePayHono(config: MonkePayConfig): MonkePayHonoInstance;
export function MonkePayHono(defaults: MonkePayHonoOverrides): MonkePayHonoInstance;
export function MonkePayHono(defaults: MonkePayHonoOverrides): MonkePayHonoInstance {
  const resolveConfig = (overrides?: MonkePayHonoOverrides): MonkePayConfig => {
    const merged = {
      ...defaults,
      ...overrides,
    } as MonkePayHonoOverrides;

    const apiKeyId = merged.apiKeyId?.trim();
    const apiKeySecret = merged.apiKeySecret?.trim();
    const price = merged.price?.trim();
    if (!apiKeyId) {
      throw new Error("apiKeyId is required. Learn more at https://docs.monke.pay");
    }
    if (!apiKeySecret) {
      throw new Error("apiKeySecret is required. Learn more at https://docs.monke.pay");
    }
    if (!price) {
      throw new Error("price is required");
    }

    return {
      apiKeyId,
      apiKeySecret,
      price,
      paymentMode: merged.paymentMode === "one_time" ? "one_time" : "per_request",
      unlockHeaderName: merged.unlockHeaderName?.trim() || "X-MonkePay-Unlock",
      apiUrl: merged.apiUrl?.trim(),
      baseUrl: merged.baseUrl?.trim(),
      onPayment: merged.onPayment,
      onError: merged.onError,
    };
  };

  let defaultMiddleware: MonkePayHonoMiddleware | null = null;

  const instance = ((arg1: Context | MonkePayHonoOverrides, arg2?: Next) => {
    const isMiddlewareCall =
      typeof arg2 === "function" &&
      typeof arg1 === "object" &&
      arg1 !== null &&
      "req" in arg1;

    if (isMiddlewareCall) {
      if (!defaultMiddleware) {
        defaultMiddleware = buildMonkePayHono(resolveConfig());
      }
      return defaultMiddleware(arg1 as Context, arg2 as Next);
    }

    return buildMonkePayHono(resolveConfig(arg1 as MonkePayHonoOverrides));
  }) as MonkePayHonoInstance;

  return instance;
}
