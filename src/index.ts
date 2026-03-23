// packages/sdk/src/index.ts

export { MonkePayHono } from "./middleware/hono.js";
export { MonkePayExpress } from "./middleware/express.js";
export { MonkePayFastify } from "./middleware/fastify.js";
export { MonkePayNext } from "./middleware/next.js";
export type {
  MonkePayConfig,
  MonkePayErrorCode,
  MonkePayErrorContext,
  MonkePayErrorPhase,
  PaymentEvent,
  WalletInfo,
} from "./types.js";

// Convenience: namespace import with all adapters
import { MonkePayHono } from "./middleware/hono.js";
import { MonkePayExpress } from "./middleware/express.js";
import { MonkePayFastify } from "./middleware/fastify.js";
import { MonkePayNext } from "./middleware/next.js"

export const MonkePay = {
  hono: MonkePayHono,
  express: MonkePayExpress,
  fastify: MonkePayFastify,
  next: MonkePayNext,
};

export default MonkePay;
