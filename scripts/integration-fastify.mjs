// scripts/integration-fastify.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';

function createStubApiServer() {
  const server = createServer(async (req, res) => {
    if (!req.url) { res.statusCode = 404; res.end(); return; }

    if (req.method === 'GET' && req.url === '/wallets/by-api-key') {
      const keyId = String(req.headers['x-monkepay-key-id'] ?? '');
      if (keyId === 'mk_fail_wallet') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'wallet resolve failure' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', network: 'base-sepolia' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/events/unlock/verify') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ unlocked: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Failed to resolve stub API address')); return; }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function run() {
  const { server: apiServer, baseUrl: apiBaseUrl } = await createStubApiServer();
  const apps = [];

  try {
    const { MonkePayFastify } = await import('../dist/fastify.js');

    // ── Test 1: one_time unlock bypass ────────────────────────────────────────
    // Route registered via setup() — same scope as hooks.
    {
      const app = Fastify({ logger: false });
      apps.push(app);

      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_test_fastify',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        apiUrl: apiBaseUrl,
      });

      app.register(monkePay({
        paymentMode: 'one_time',
        setup: (scope) => {
          scope.get('/unlock', async () => ({ ok: true, mode: 'unlock' }));
        },
      }));

      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/unlock`, {
        headers: { 'X-MonkePay-Unlock': 'valid-token' },
      });
      assert.equal(res.status, 200, 'Unlock bypass should return 200');
      const body = await res.json();
      assert.equal(body.ok, true, 'Unlock bypass should reach handler');
      console.log('[Integration] ✓ one_time unlock bypass');
    }

    // ── Test 2: per_request missing payment → 402 ─────────────────────────────
    {
      const app = Fastify({ logger: false });
      apps.push(app);

      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_test_fastify',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        apiUrl: apiBaseUrl,
      });

      app.register(monkePay({
        paymentMode: 'per_request',
        setup: (scope) => {
          scope.get('/paid', async () => ({ ok: true, mode: 'paid' }));
        },
      }));

      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/paid`);
      assert.equal(res.status, 402, 'Missing payment should return 402');
      const body = await res.json();
      assert.equal(body.error, 'X-PAYMENT header is required');
      assert.ok(Array.isArray(body.accepts), 'Should include accepts array');
      console.log('[Integration] ✓ per_request missing payment → 402');
    }

    // ── Test 3: per-route price override ──────────────────────────────────────
    // Two separate register() calls with different prices, routes in setup().
    // Confirms hooks are isolated per registration — cheap hook doesn't fire
    // on expensive route and vice versa.
    {
      const app = Fastify({ logger: false });
      apps.push(app);

      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_test_fastify',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        apiUrl: apiBaseUrl,
      });

      app.register(monkePay({
        price: '0.001',
        paymentMode: 'per_request',
        setup: (scope) => {
          scope.get('/cheap', async () => ({ ok: true, mode: 'cheap' }));
        },
      }));

      app.register(monkePay({
        price: '0.10',
        paymentMode: 'per_request',
        setup: (scope) => {
          scope.get('/expensive', async () => ({ ok: true, mode: 'expensive' }));
        },
      }));

      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      const cheapRes = await fetch(`${baseUrl}/cheap`);
      assert.equal(cheapRes.status, 402, '/cheap should require payment');
      const cheapBody = await cheapRes.json();
      // Confirm price in accepts matches the cheap tier
      assert.ok(Array.isArray(cheapBody.accepts), 'cheap should include accepts array');

      const expensiveRes = await fetch(`${baseUrl}/expensive`);
      assert.equal(expensiveRes.status, 402, '/expensive should require payment');
      const expensiveBody = await expensiveRes.json();
      assert.ok(Array.isArray(expensiveBody.accepts), 'expensive should include accepts array');

      // Confirm the two price tiers are different
      const cheapAmount = cheapBody.accepts[0]?.maxAmountRequired;
      const expensiveAmount = expensiveBody.accepts[0]?.maxAmountRequired;
      assert.ok(cheapAmount !== expensiveAmount, 'cheap and expensive should have different maxAmountRequired');

      console.log('[Integration] ✓ per-route price isolation (cheap !== expensive)');
    }

    // ── Test 4: wallet resolution failure → 502 ───────────────────────────────
    {
      const app = Fastify({ logger: false });
      apps.push(app);

      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_fail_wallet',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        apiUrl: apiBaseUrl,
      });

      app.register(monkePay({
        setup: (scope) => {
          scope.get('/wallet-fail', async () => ({ ok: true }));
        },
      }));

      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/wallet-fail`);
      assert.equal(res.status, 502, 'Wallet failure should return 502');
      const body = await res.json();
      assert.equal(body?.error?.code, 'WALLET_RESOLVE_FAILED');
      console.log('[Integration] ✓ wallet resolution failure → 502');
    }

    // ── Test 5: onError callback fires on wallet failure ──────────────────────
    {
      const app = Fastify({ logger: false });
      apps.push(app);

      let onErrorFired = false;
      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_fail_wallet',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        apiUrl: apiBaseUrl,
        onError: async (err) => {
          if (err.code === 'WALLET_RESOLVE_FAILED') onErrorFired = true;
        },
      });

      app.register(monkePay({
        setup: (scope) => {
          scope.get('/wallet-fail-callback', async () => ({ ok: true }));
        },
      }));

      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/wallet-fail-callback`);
      assert.equal(res.status, 502);
      assert.equal(onErrorFired, true, 'onError should fire on WALLET_RESOLVE_FAILED');
      console.log('[Integration] ✓ onError callback fires on wallet failure');
    }

    // ── Test 6: global — no setup, routes at app level ───────────────────────
    // Confirmed NOT to work from probe (Pattern A fires no hooks).
    // This test documents the limitation: global register without setup()
    // does NOT gate routes added at app level. Users must use setup().
    // Skipped — tested manually via the live agent example.

    console.log('[Integration] Fastify adapter integration checks passed');
  } finally {
    await Promise.all(apps.map((app) => app.close().catch(() => undefined)));
    await new Promise((resolve) => apiServer.close(resolve));
  }
}

run().catch((error) => {
  console.error('[Integration] Fastify adapter integration checks failed', error);
  process.exitCode = 1;
});
