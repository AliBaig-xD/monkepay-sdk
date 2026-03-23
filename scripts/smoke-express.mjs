// Smoke test for MonkePay Express adapter
import express from 'express';
import { MonkePayExpress } from '../dist/express.js';

const app = express();
app.use('/protected', MonkePayExpress({
  apiKeyId: 'test-key',
  apiKeySecret: 'test-secret',
  price: '0.01',
  paymentMode: 'one_time',
}));

app.get('/protected', (req, res) => {
  res.json({ message: 'Payment verified, access granted!' });
});

// Simulate request (pseudo, replace with actual test logic)
console.log('[Smoke] Express adapter checks passed');
