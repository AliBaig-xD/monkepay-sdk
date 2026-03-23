import {
  createSdkError,
  emitOnErrorSafe,
  sanitizeErrorMessage,
  toPublicErrorResponse,
  MonkePaySdkError,
} from "../errors.js";
import { extractAgentAddress, extractSettledTxHash } from "../payment-headers.js";
import { recordPaymentEvent, resolveWallet, verifyUnlockToken } from "../wallet.js";
import type {
  MonkePayConfig,
  PaymentEvent,
  SupportedNetwork,
  WalletInfo,
} from "../types.js";

export type MonkePayMiddlewareState = {
  payTo: string | null;
  payNetwork: SupportedNetwork | null;
  walletPromise: Promise<WalletInfo> | null;
};

type MonkePayRouteConfig = {
  price: string;
  network: SupportedNetwork;
};

type MonkePayRoutes = Record<string, MonkePayRouteConfig>;

export type MonkePayCoreAdapter<TContext, TResult, TX402Result> = {
  getPath: (context: TContext) => string;
  getHeader: (context: TContext, name: string) => string | undefined;
  runX402: (
    context: TContext,
    payTo: string,
    routes: MonkePayRoutes,
    proceed: () => Promise<void>,
  ) => Promise<TX402Result>;
  getStatus: (context: TContext, x402Result: TX402Result) => number;
  getPaymentResponseHeader: (context: TContext, x402Result: TX402Result) => string;
  setHeader: (context: TContext, x402Result: TX402Result, name: string, value: string) => void;
  onUnlockedBypass: (context: TContext) => Promise<TResult>;
  finalizeFromX402: (context: TContext, x402Result: TX402Result) => TResult;
  onPublicError: (
    context: TContext,
    error: ReturnType<typeof toPublicErrorResponse>,
    cause: unknown,
  ) => TResult | Promise<TResult>;
};

export async function runMonkePayCore<TContext, TResult, TX402Result>(
  context: TContext,
  proceed: () => Promise<void>,
  config: MonkePayConfig,
  state: MonkePayMiddlewareState,
  adapter: MonkePayCoreAdapter<TContext, TResult, TX402Result>,
): Promise<TResult> {
  const paymentMode = config.paymentMode ?? "per_request";
  const unlockHeaderName = config.unlockHeaderName ?? "X-MonkePay-Unlock";
  const endpoint = adapter.getPath(context);

  try {
    if (paymentMode === "one_time") {
      const unlockToken = adapter.getHeader(context, unlockHeaderName) ?? "";

      if (unlockToken) {
        try {
          const verification = await verifyUnlockToken(
            {
              endpoint,
              token: unlockToken,
            },
            {
              apiKeyId: config.apiKeyId,
              apiKeySecret: config.apiKeySecret,
              apiUrl: config.apiUrl,
            },
          );

          if (verification.unlocked) {
            await proceed();
            return await adapter.onUnlockedBypass(context);
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
        }
      }
    }

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

      let wallet: WalletInfo;
      try {
        wallet = await state.walletPromise;
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

      state.payTo = wallet.address;
      state.payNetwork = wallet.network;
    }

    const normalizedPrice = config.price.startsWith("$") ? config.price : `$${config.price}`;
    const routes = {
      [endpoint]: {
        price: normalizedPrice,
        network: state.payNetwork ?? "base",
      },
    } as MonkePayRoutes;

    const paymentHeader = adapter.getHeader(context, "X-Payment") ?? "";

    let x402Result: TX402Result;
    try {
      x402Result = await adapter.runX402(context, state.payTo as string, routes, proceed);
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

    if (adapter.getStatus(context, x402Result) >= 400) {
      return adapter.finalizeFromX402(context, x402Result);
    }

    const paymentResponseHeader = adapter.getPaymentResponseHeader(context, x402Result);
    const resolvedTxHash = extractSettledTxHash(paymentResponseHeader);
    const paymentEvent = {
      agentAddress: extractAgentAddress(paymentHeader),
      amountUSDC: normalizedPrice.replace(/^\$/, ""),
      txHash: resolvedTxHash,
      timestamp: new Date(),
      endpoint,
    } as PaymentEvent;

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
          {
            apiKeyId: config.apiKeyId,
            apiKeySecret: config.apiKeySecret,
            apiUrl: config.apiUrl,
          },
        );

        if (paymentMode === "one_time" && eventResult.unlockToken) {
          adapter.setHeader(context, x402Result, unlockHeaderName, eventResult.unlockToken);
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

    return adapter.finalizeFromX402(context, x402Result);
  } catch (error) {
    // WALLET_RESOLVE_FAILED and PAYMENT_MIDDLEWARE_FAILED already called
    // emitOnErrorSafe before rethrowing as MonkePaySdkError. Skip re-emitting
    // to avoid firing onError twice for those phases.
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

    return await adapter.onPublicError(context, toPublicErrorResponse(error), error);
  }
}
