// index.js
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const {
  sendOrderToPrintoteca,
  cancelPrintotecaOrderFromShopifyOrderId,
} = require('./printoteca');

const {
  pollPrintotecaTrackingOnce,
  resyncSingleShopifyOrderFromPrintoteca,
} = require('./tracking');

const app = express();

// Simple health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Shopify webhooks need RAW body for HMAC verification
app.use(
  '/webhooks/shopify/orders-paid',
  bodyParser.raw({ type: 'application/json' }),
);

app.use(
  '/webhooks/shopify/orders-cancelled',
  bodyParser.raw({ type: 'application/json' }),
);

// -----------------------------
// Shopify orders/paid webhook
// -----------------------------
app.post('/webhooks/shopify/orders-paid', async (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const rawBody = req.body; // Buffer

    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      console.warn('Invalid Shopify webhook signature (orders-paid)');
      return res.status(401).send('Unauthorized');
    }

    if (topic !== 'orders/paid') {
      // We only care about paid orders here
      return res.status(200).send('Ignored');
    }

    const order = JSON.parse(rawBody.toString('utf8'));

    console.log(
      `Received paid order ${order.id} / ${order.name} – queueing for Printoteca`,
    );

    // Do NOT await – let this run in the background
    queueSendOrderToPrintoteca(order);

    // Immediately reply OK to Shopify so the webhook doesn’t time out
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling orders-paid webhook', err);
    res.status(500).send('Error');
  }
});

// ------------------------------------
// Shopify orders/cancelled webhook (A)
// ------------------------------------
app.post('/webhooks/shopify/orders-cancelled', async (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const rawBody = req.body; // Buffer

    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      console.warn('Invalid Shopify webhook signature (orders-cancelled)');
      return res.status(401).send('Unauthorized');
    }

    if (topic !== 'orders/cancelled') {
      // Only care about cancellations here
      return res.status(200).send('Ignored');
    }

    const order = JSON.parse(rawBody.toString('utf8'));
    const shopifyOrderId = order.id;

    console.log(
      `Received cancelled order ${shopifyOrderId} / ${order.name} – cancelling at Printoteca`,
    );

    // Don’t block Shopify – handle in the background
    cancelPrintotecaOrderFromShopifyOrderId(shopifyOrderId).catch((err) => {
      console.error(
        `Failed to cancel Printoteca order for Shopify order ${shopifyOrderId}`,
        err,
      );
    });

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling orders-cancelled webhook', err);
    res.status(500).send('Error');
  }
});

// -----------------------------
// HMAC verification helper
// -----------------------------
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      'SHOPIFY_WEBHOOK_SECRET not configured – refusing to accept webhook',
    );
    return false;
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmacHeader, 'utf8');

  if (digestBuffer.length !== hmacBuffer.length) return false;

  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
}

// ------------------------------------------------------
// Queue sending the order to Printoteca with a delay
// (gives Teeinblue time to finish generating designs)
// ------------------------------------------------------
function queueSendOrderToPrintoteca(order) {
  const delayMs = Number(process.env.PRINTOTECA_RETRY_DELAY_MS || 300000); // default 5 minutes
  const waitSec = Math.round(delayMs / 1000);

  console.log(
    `Waiting ${waitSec} seconds before first send to Printoteca for Shopify order ${order.id}...`,
  );

  setTimeout(() => {
    sendOrderToPrintoteca(order).catch((err) => {
      console.error(
        `Error sending Shopify order ${order.id} to Printoteca:`,
        err && err.message ? err.message : err,
      );
    });
  }, delayMs);
}

// ----------------------------------------------
// Tracking job endpoint (for cron / manual runs)
// ----------------------------------------------
app.get('/jobs/pull-printoteca-tracking', async (req, res) => {
  try {
    const jobToken = process.env.JOB_SECRET;

    if (jobToken && req.query.token !== jobToken) {
      return res.status(401).send('Unauthorized');
    }

    const result = await pollPrintotecaTrackingOnce();
    res.json(result || { synced: 0, errors: 0 });
  } catch (err) {
    console.error('Tracking job error', err);
    res.status(500).send('Error');
  }
});

// -------------------------------------------------
// Manual “resync this order from Printoteca” (C)
// GET /admin/printoteca-sync/:orderId?token=SECRET
// -------------------------------------------------
app.get('/admin/printoteca-sync/:orderId', async (req, res) => {
  try {
    const jobToken = process.env.JOB_SECRET;

    if (jobToken && req.query.token !== jobToken) {
      return res.status(401).send('Unauthorized');
    }

    const shopifyOrderId = req.params.orderId;

    const pOrder = await resyncSingleShopifyOrderFromPrintoteca(
      shopifyOrderId,
    );

    if (!pOrder) {
      return res.status(404).json({
        ok: false,
        message:
          'No Printoteca order found for this Shopify order (maybe not sent yet?)',
      });
    }

    res.json({
      ok: true,
      printotecaOrder: pOrder,
    });
  } catch (err) {
    console.error('Manual resync error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Gateway listening on port ${port}`);
});
