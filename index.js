require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const {
  createPrintotecaOrderFromShopifyOrder,
  listPrintotecaOrders,
  listRecentPrintotecaOrders,
  getPrintotecaOrderById,
  deletePrintotecaOrderById,
  countPrintotecaOrders,
  findPrintotecaOrderByExternalId
} = require('./printoteca');

const { pollPrintotecaTrackingOnce } = require('./tracking');

const app = express();

// ---------------------------
// Health check
// ---------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------
// Webhook body: raw buffer
// ---------------------------

app.use('/webhooks/shopify/orders-paid', bodyParser.raw({ type: 'application/json' }));
app.use('/webhooks/shopify/orders-cancelled', bodyParser.raw({ type: 'application/json' }));

// JSON parser for all other routes
app.use(express.json());

// ---------------------------
// Shopify webhooks
// ---------------------------

app.post('/webhooks/shopify/orders-paid', (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shopDomain = req.get('X-Shopify-Shop-Domain');
    const rawBody = req.body; // Buffer

    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      console.warn('Webhook orders-paid: invalid Shopify HMAC');
      return res.status(401).send('Unauthorized');
    }

    if (topic !== 'orders/paid') {
      console.log('Webhook orders-paid: ignoring topic', topic);
      return res.status(200).send('Ignored');
    }

    let order;
    try {
      order = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      console.error('Webhook orders-paid: invalid JSON body');
      return res.status(400).send('Invalid JSON');
    }

    console.log(
      `Webhook orders-paid: received order ${order.id} (${order.name}) from ${shopDomain}`
    );

    // fire-and-forget with retry logic
    sendOrderToPrintotecaWithRetry(order).catch((err) => {
      console.error('Background error sending order to Printoteca', err);
    });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error in /webhooks/shopify/orders-paid', err);
    return res.status(500).send('Error');
  }
});

app.post('/webhooks/shopify/orders-cancelled', (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shopDomain = req.get('X-Shopify-Shop-Domain');
    const rawBody = req.body; // Buffer

    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      console.warn('Webhook orders-cancelled: invalid Shopify HMAC');
      return res.status(401).send('Unauthorized');
    }

    if (topic !== 'orders/cancelled') {
      console.log('Webhook orders-cancelled: ignoring topic', topic);
      return res.status(200).send('Ignored');
    }

    let order;
    try {
      order = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      console.error('Webhook orders-cancelled: invalid JSON body');
      return res.status(400).send('Invalid JSON');
    }

    console.log(
      `Webhook orders-cancelled: received order ${order.id} (${order.name}) from ${shopDomain}`
    );

    // fire-and-forget cancellation handler
    handleShopifyCancellation(order).catch((err) => {
      console.error('Background error cancelling Printoteca order', err);
    });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error in /webhooks/shopify/orders-cancelled', err);
    return res.status(500).send('Error');
  }
});

// ---------------------------
// Shopify HMAC verification
// ---------------------------

function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('SHOPIFY_WEBHOOK_SECRET not configured');
    return false;
  }

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmacHeader, 'utf8');

  if (digestBuffer.length !== hmacBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
}

// ---------------------------
// Retry logic for Printoteca
// ---------------------------

async function sendOrderToPrintotecaWithRetry(order, attempt = 1) {
  const maxAttempts = Number(process.env.PRINTOTECA_MAX_ATTEMPTS || 5);
  const delayMs = Number(process.env.PRINTOTECA_RETRY_DELAY_MS || 300000); // default 5min
  const waitSec = Math.round(delayMs / 1000);

  const doSend = async () => {
    try {
      const resp = await createPrintotecaOrderFromShopifyOrder(order);
      console.log(
        `Printoteca: sent order ${order.id} on attempt ${attempt}, response:`,
        JSON.stringify(resp)
      );
    } catch (err) {
      const msg = err.response?.data || err.message || '';
      const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);

      console.error(
        `Printoteca: error sending order ${order.id} on attempt ${attempt}:`,
        msgStr
      );

      const isDesignUrlError = msgStr.includes('Design url is not valid');

      if (isDesignUrlError && attempt < maxAttempts) {
        console.log(
          `Printoteca: design probably not ready yet, will retry in ${waitSec} seconds (attempt ${
            attempt + 1
          }/${maxAttempts})`
        );

        setTimeout(() => {
          sendOrderToPrintotecaWithRetry(order, attempt + 1).catch((e) =>
            console.error('Printoteca retry error', e)
          );
        }, delayMs);
      } else {
        console.log('Printoteca: not retrying this order any further.');
      }
    }
  };

  if (attempt === 1) {
    console.log(
      `Printoteca: waiting ${waitSec} seconds before FIRST send for Shopify order ${order.id}...`
    );
    setTimeout(() => {
      doSend().catch((e) =>
