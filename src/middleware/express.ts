// packages/sdk/src/middleware/express.ts

import { paymentMiddleware } from "x402-express";
import { runMonkePayCore, type MonkePayMiddlewareState } from "./core.js";
import type { MonkePayConfig } from "../types.js";
import type { Request, Response, NextFunction } from "express";

type MonkePayExpressMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;
type MonkePayExpressOverrides = Partial<MonkePayConfig>;
type MonkePayExpressInstance = {
  (req: Request, res: Response, next: NextFunction): Promise<void>;
  (overrides: MonkePayExpressOverrides): MonkePayExpressMiddleware;
};

// Per-request buffer — populated by runX402 to hold the route handler's
// response body and the original res.end, then flushed by finalizeFromX402
// after header injection (e.g. X-MonkePay-Unlock for one_time mode).
type BufferedResponse = {
  chunks: Buffer[];
  endCallbacks: Array<() => void>;
  originalEnd: (...args: any[]) => any;
};

function buildMonkePayExpress(config: MonkePayConfig): MonkePayExpressMiddleware {
  const state: MonkePayMiddlewareState = {
    payTo: null,
    payNetwork: null,
    walletPromise: null,
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    // Shared per-request across runX402 → setHeader → finalizeFromX402.
    let buffer: BufferedResponse | null = null;

    await runMonkePayCore(req, async () => {
      await next();
    }, config, state, {
      getPath: (request) => request.path,
      getHeader: (request, name) => request.header(name) ?? undefined,

      runX402: async (request, payTo, routes, proceed) => {
        // Intercept res.write/end so the route handler's res.json() doesn't
        // flush to the socket yet. We need to be able to inject headers
        // (e.g. X-MonkePay-Unlock) after recordPaymentEvent resolves.
        const chunks: Buffer[] = [];
        const endCallbacks: Array<() => void> = [];
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);

        // Patch headersSent so downstream middleware that checks it during
        // the buffer window sees true and doesn't attempt to re-send.
        const originalHeadersSentDescriptor = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(res),
          "headersSent",
        );
        Object.defineProperty(res, "headersSent", { get: () => true, configurable: true });

        (res as any).write = (chunk: any, enc?: any, cb?: any) => {
          if (chunk) {
            chunks.push(
              Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk, typeof enc === "string" ? enc as BufferEncoding : "utf8"),
            );
          }
          // Fire write callback immediately so the caller isn't stalled.
          const callback = typeof enc === "function" ? enc : cb;
          if (typeof callback === "function") setImmediate(callback);
          return true;
        };

        (res as any).end = (chunk?: any, enc?: any, cb?: any) => {
          if (chunk && typeof chunk !== "function") {
            chunks.push(
              Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk, typeof enc === "string" ? enc as BufferEncoding : "utf8"),
            );
          }
          // Collect end callbacks — fire them after the real flush in finalizeFromX402.
          const callback = typeof enc === "function" ? enc : typeof cb === "function" ? cb : null;
          if (callback) endCallbacks.push(callback);
          return res;
        };

        const x402 = paymentMiddleware(payTo as `0x${string}`, routes);
        await x402(request, res, async () => {
          await proceed();
        });

        // Restore write/end and headersSent before finalizeFromX402 flushes.
        (res as any).write = originalWrite;
        (res as any).end = originalEnd;
        if (originalHeadersSentDescriptor) {
          Object.defineProperty(res, "headersSent", originalHeadersSentDescriptor);
        } else {
          delete (res as any).headersSent;
        }

        buffer = { chunks, endCallbacks, originalEnd };
        return undefined;
      },

      getStatus: () => res.statusCode,
      getPaymentResponseHeader: () => String(res.getHeader("X-PAYMENT-RESPONSE") ?? ""),

      setHeader: (_request, _x402Result, name, value) => {
        // Safe — socket not yet flushed thanks to the buffer above.
        res.setHeader(name, value);
      },

      onUnlockedBypass: async () => undefined,

      finalizeFromX402: () => {
        if (buffer) {
          // All headers including X-MonkePay-Unlock are set. Now flush.
          const { chunks, endCallbacks, originalEnd } = buffer;
          buffer = null;
          const body = Buffer.concat(chunks);
          if (body.length > 0) {
            originalEnd(body, () => { endCallbacks.forEach((cb) => cb()); });
          } else {
            originalEnd(() => { endCallbacks.forEach((cb) => cb()); });
          }
        }
        return undefined;
      },

      onPublicError: (_request, publicError, cause) => {
        // 402 / error paths: x402-express sends its own response directly,
        // buffer is never populated, headersSent check is correct here.
        if (!res.headersSent) {
          res.status(publicError.status).json(publicError.body);
          return;
        }
        next(cause);
      },
    });
  };
}

export function MonkePayExpress(config: MonkePayConfig): MonkePayExpressInstance;
export function MonkePayExpress(defaults: MonkePayExpressOverrides): MonkePayExpressInstance;
export function MonkePayExpress(defaults: MonkePayExpressOverrides): MonkePayExpressInstance {
  const resolveConfig = (overrides?: MonkePayExpressOverrides): MonkePayConfig => {
    const merged = {
      ...defaults,
      ...overrides,
    } as MonkePayExpressOverrides;

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

  let defaultMiddleware: MonkePayExpressMiddleware | null = null;

  const instance = ((
    arg1: Request | MonkePayExpressOverrides,
    arg2?: Response,
    arg3?: NextFunction,
  ) => {
    const isMiddlewareCall =
      typeof arg3 === "function" &&
      typeof arg1 === "object" &&
      arg1 !== null &&
      "headers" in arg1;

    if (isMiddlewareCall) {
      if (!defaultMiddleware) {
        defaultMiddleware = buildMonkePayExpress(resolveConfig());
      }

      return defaultMiddleware(arg1 as Request, arg2 as Response, arg3);
    }

    return buildMonkePayExpress(resolveConfig(arg1 as MonkePayExpressOverrides));
  }) as MonkePayExpressInstance;

  return instance;
}
