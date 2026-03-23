// scripts/smoke-fastify.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

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

// Minimal Fastify-like instance — registers hooks and lets us invoke them
// directly without a real Fastify server.
function createFakeInstance() {
  const hooks = { preHandler: [], onSend: [] };
  return {
    addHook(name, fn) { hooks[name]?.push(fn); },
    async runPreHandler(request, reply) {
      for (const fn of hooks.preHandler) await fn(request, reply);
    },
    async runOnSend(request, reply, payload) {
      let current = payload;
      for (const fn of hooks.onSend) current = await fn(request, reply, current) ?? current;
      return current;
    },
  };
}

function makeRequest(url, headers = {}) {
  return {
    method: 'GET',
    url,
    protocol: 'http',
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    raw: { method: 'GET', headers: {} },
    _monkePayContext: undefined,
  };
}

function makeReply() {
  const state = { statusCode: 200, sent: false, headers: {}, payload: undefined };
  return {
    get statusCode() { return state.statusCode; },
    get sent() { return state.sent; },
    code(s) { state.statusCode = Number(s); return this; },
    send(p) { state.payload = p; state.sent = true; return this; },
    header(n, v) { state.headers[n] = v; return this; },
    raw: {
      get statusCode() { return state.statusCode; },
      getHeader(n) { return state.headers[n]; },
      setHeader(n, v) { state.headers[n] = v; },
    },
    getState: () => state,
  };
}

async function run() {
  const { server, baseUrl } = await createStubApiServer();

  try {
    const { MonkePayFastify } = await import('../dist/fastify.js');

    // ── Test 1: one_time unlock bypass ────────────────────────────────────────
    // Valid unlock token → preHandler sets bypassed context, does not send 402,
    // onSend passes payload through untouched.
    {
      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_test_fastify',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        paymentMode: 'one_time',
        apiUrl: baseUrl,
      });

      const instance = createFakeInstance();
      monkePay()(instance, {}, () => {});

      const req = makeRequest('/api/data', { 'x-monkepay-unlock': 'valid-token' });
      const reply = makeReply();

      await instance.runPreHandler(req, reply);

      assert.equal(reply.getState().sent, false, 'Unlock bypass should not send 402');
      assert.equal(reply.getState().statusCode, 200, 'Unlock bypass should leave status 200');
      assert.deepEqual(req._monkePayContext, { bypassed: true }, 'Should attach bypassed context');

      // onSend should pass payload through without settling
      const payload = JSON.stringify({ ok: true });
      const result = await instance.runOnSend(req, reply, payload);
      assert.equal(result, payload, 'onSend should passthrough on bypass');

      console.log('[Smoke] ✓ one_time unlock bypass');
    }

    // ── Test 2: per_request missing payment → 402 ─────────────────────────────
    // No X-Payment header → preHandler sends 402 with accepts array.
    // _monkePayContext stays undefined → onSend passthrough.
    {
      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_test_fastify',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        paymentMode: 'per_request',
        apiUrl: baseUrl,
      });

      const instance = createFakeInstance();
      monkePay()(instance, {}, () => {});

      const req = makeRequest('/api/data');
      const reply = makeReply();

      await instance.runPreHandler(req, reply);

      assert.equal(reply.getState().statusCode, 402, 'Missing payment should return 402');
      assert.equal(reply.getState().payload?.error, 'X-PAYMENT header is required');
      assert.ok(Array.isArray(reply.getState().payload?.accepts), 'Should include accepts array');
      assert.equal(req._monkePayContext, undefined, 'No context should be attached on 402');

      console.log('[Smoke] ✓ per_request missing payment → 402');
    }

    // ── Test 3: wallet resolution failure → 502 ───────────────────────────────
    // Backend returns 500 for mk_fail_wallet → 502 WALLET_RESOLVE_FAILED.
    {
      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_fail_wallet',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        paymentMode: 'per_request',
        apiUrl: baseUrl,
      });

      const instance = createFakeInstance();
      monkePay()(instance, {}, () => {});

      const req = makeRequest('/api/data');
      const reply = makeReply();

      await instance.runPreHandler(req, reply);

      assert.equal(reply.getState().statusCode, 502, 'Wallet failure should return 502');
      assert.equal(reply.getState().payload?.error?.code, 'WALLET_RESOLVE_FAILED');
      assert.equal(req._monkePayContext, undefined, 'No context should be attached on wallet failure');

      console.log('[Smoke] ✓ wallet resolution failure → 502');
    }

    // ── Test 4: onSend passthrough — no context ───────────────────────────────
    // When _monkePayContext is undefined (route not metered), onSend is a no-op.
    {
      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_test_fastify',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        apiUrl: baseUrl,
      });

      const instance = createFakeInstance();
      monkePay()(instance, {}, () => {});

      const req = makeRequest('/api/data');
      const reply = makeReply();
      const payload = JSON.stringify({ ok: true });

      const result = await instance.runOnSend(req, reply, payload);
      assert.equal(result, payload, 'onSend should passthrough with no context');

      console.log('[Smoke] ✓ onSend passthrough — no context');
    }

    // ── Test 5: onSend passthrough — handler error ────────────────────────────
    // If handler responded with 4xx/5xx, onSend should not settle.
    {
      const monkePay = MonkePayFastify({
        apiKeyId: 'mk_test_fastify',
        apiKeySecret: 'sk_test_fastify',
        price: '0.001',
        apiUrl: baseUrl,
      });

      const instance = createFakeInstance();
      monkePay()(instance, {}, () => {});

      const req = makeRequest('/api/data');
      // Simulate a verified payment context attached but handler errored
      req._monkePayContext = {
        bypassed: false,
        decodedPayment: {},
        selectedRequirements: {},
        paymentRequirements: [],
        x402Version: 1,
        paymentHeader: '',
        normalizedPrice: '$0.001',
        endpoint: '/api/data',
      };

      const reply = makeReply();
      reply.code(500);

      const payload = JSON.stringify({ error: 'handler error' });
      const result = await instance.runOnSend(req, reply, payload);
      assert.equal(result, payload, 'onSend should not settle when handler errored');

      console.log('[Smoke] ✓ onSend passthrough — handler error');
    }

    console.log('[Smoke] Fastify adapter checks passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error('[Smoke] Fastify adapter checks failed', error);
  process.exitCode = 1;
});
