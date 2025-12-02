require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { sendOrderToPrintoteca, cancelPrintotecaOrder } = require('./printoteca');  // Correct import
const { pollPrintotecaTrackingOnce } = require('./tracking');
const crypto = require('crypto');

const app = express();

// Simple health check endpoint
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Shopify webhook needs raw body for HMAC verification
app.use('/webhooks/shopify/orders-paid', bodyParser.raw({ type: 'application/json' }));
app.use('/webhooks/shopify/orders-cancelled', bodyParser.raw({ type: 'application/json' }));

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

    // Start Printoteca flow in the background (1-minute delay before sending order)
    sendOrderToPrintotecaWithRetry(order);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling orders-paid webhook', err);
    res.status(500).send('Error');
  }
});

// Shopify orders-cancelled webhook
app.post('/webhooks/shopify/orders-cancelled', async (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const rawBody = req.body; // Buffer

    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      console.warn('Invalid Shopify webhook signature');
      return res.status(401).send('Unauthorized');
    }

    if (topic !== 'orders/cancelled') {
      console.log('Ignoring topic:', topic);
      return res.status(200).send('Ignored');
    }

    const order = JSON.parse(rawBody.toString('utf8'));
    console.log(`Received cancellation for order ${order.id} / ${order.name}`);

    // Call cancelPrintotecaOrder from the imported module
    await cancelPrintotecaOrder(order);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling orders-cancelled webhook', err);
    res.status(500).send('Error');
  }
});

// Shopify HMAC verification
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmacHeader, 'utf8');

  if (digestBuffer.length !== hmacBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
}

// Retry logic for sending orders to Printoteca
async function sendOrderToPrintotecaWithRetry(order, attempt = 1) {
  const maxAttempts = Number(process.env.PRINTOTECA_MAX_ATTEMPTS || 5);
  const delayMs = 60000; // 1-minute delay
  const waitSec = Math.round(delayMs / 1000);

  const doSend = async () => {
    try {
      const resp = await sendOrderToPrintoteca(order);
      console.log(`Sent order ${order.id} to Printoteca on attempt ${attempt}, response:`, resp.status);
    } catch (err) {
      const msg = err.response?.data || err.message || '';
      const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);

      console.error(`Error sending order ${order.id} to Printoteca on attempt ${attempt}:`, msgStr);

      if (attempt < maxAttempts) {
        console.log(`Retrying order ${order.id} after ${waitSec} seconds...`);
        setTimeout(() => {
          sendOrderToPrintotecaWithRetry(order, attempt + 1);
        }, delayMs);
      } else {
        console.log('Not retrying this order any further.');
      }
    }
  };

  if (attempt === 1) {
    console.log(`Waiting ${waitSec} seconds before sending order ${order.id} to Printoteca...`);
    setTimeout(() => {
      doSend();
    }, delayMs);
  } else {
    await doSend();
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Gateway listening on port ${port}`);
});
