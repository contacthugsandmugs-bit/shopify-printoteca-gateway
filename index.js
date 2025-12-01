require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const { sendOrderToPrintoteca } = require('./printoteca');
const { pollPrintotecaTrackingOnce } = require('./tracking');

const app = express();

// simple health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Shopify webhook needs raw body for HMAC verification
app.use(
  '/webhooks/shopify/orders-paid',
  bodyParser.raw({ type: 'application/json' })
);

// Shopify orders-paid webhook
app.post('/webhooks/shopify/orders-paid', async (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');

    const rawBody = req.body; // Buffer

    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      console.warn('Invalid Shopify webhook signature');
      return res.status(401).send('Unauthorized');
    }

    if (topic !== 'orders/paid') {
      return res.status(200).send('Ignored');
    }

    const order = JSON.parse(rawBody.toString('utf8'));
    console.log(`Received paid order ${order.id} / ${order.name}`);

    const printotecaRes = await sendOrderToPrintoteca(order);
    console.log('Sent to Printoteca, status:', printotecaRes.status);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling orders-paid webhook', err);
    res.status(500).send('Error');
  }
});

function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmacHeader, 'utf8');

  // timingSafeEqual throws if lengths differ, so guard first
  if (digestBuffer.length !== hmacBuffer.length) return false;

  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
}

// tracking job endpoint (for cron / manual runs)
app.get('/jobs/pull-printoteca-tracking', async (req, res) => {
  try {
    const jobToken = process.env.JOB_SECRET;
    if (jobToken && req.query.token !== jobToken) {
      return res.status(401).send('Unauthorized');
    }

    const result = await pollPrintotecaTrackingOnce();
    res.json(result);
  } catch (err) {
    console.error('Tracking job error', err);
    res.status(500).send('Error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Gateway listening on port ${port}`);
});
