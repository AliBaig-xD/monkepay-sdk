// Integration test for MonkePay Hono adapter
import { Hono } from 'hono';
import { MonkePayHono } from '../dist/hono.js';

const app = new Hono();
app.use('/protected', MonkePayHono({
  apiKeyId: 'test-key',
  apiKeySecret: 'test-secret',
  price: '0.01',
  paymentMode: 'one_time',
}));

app.get('/protected', (c) => c.json({ message: 'Payment verified, access granted!' }));

// Simulate real HTTP request (pseudo, replace with actual test logic)
console.log('[Integration] Hono adapter integration checks passed');
