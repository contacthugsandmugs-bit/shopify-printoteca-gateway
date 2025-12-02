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

// For normal JSON routes
app.use(bodyParser.json());

// -----------------------------------------------------
// Helper: verify Shopify webhook HMAC
// -----------------------------------------------------
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!hmacHeader) return false;

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('SHOPIFY_WEBHOOK_SECRET not configured');
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

// -----------------------------------------------------
// Shopify orders/paid webhook
// -----------------------------------------------------
app.post(
  '/webhooks/shopify/orders-paid',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmacHeader = req.get('x-shopify-hmac-sha256');
      const topic = req.get('x-shopify-topic');
      const rawBody = req.body; // Buffer

      if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
        console.warn('Invalid Shopify webhook signature (orders-paid)');
        return res.status(401).send('Unauthorized');
      }

      if (topic !== 'orders/paid') {
        return res.status(200).send('Ignored');
      }

      const order = JSON.parse(rawBody.toString('utf8'));
      console.log(
        `Received paid order ${order.id} / ${order.name} – queueing for Printoteca`,
      );

      // Run in background after a delay
      queueSendOrderToPrintoteca(order);

      return res.status(200).send('OK');
    } catch (err) {
      console.error('Error handling orders-paid webhook', err);
      return res.status(500).send('Error');
    }
  },
);

// -----------------------------------------------------
// Shopify orders/cancelled webhook
// -----------------------------------------------------
app.post(
  '/webhooks/shopify/orders-cancelled',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const hmacHeader = req.get('x-shopify-hmac-sha256');
      const topic = req.get('x-shopify-topic');
      const rawBody = req.body; // Buffer

      if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
        console.warn('Invalid Shopify webhook signature (orders-cancelled)');
        return res.status(401).send('Unauthorized');
      }

      if (topic !== 'orders/cancelled') {
        return res.status(200).send('Ignored');
      }

      const order = JSON.parse(rawBody.toString('utf8'));
      const shopifyOrderId = order.id;

      console.log(
        `Received cancelled order ${shopifyOrderId} / ${order.name} – cancelling at Printoteca`,
      );

      // Handle asynchronously so webhook reply is fast
      (async () => {
        try {
          await cancelPrintotecaOrderFromShopifyOrderId(shopifyOrderId);
        } catch (err) {
          console.error(
            `[orders-cancelled] Failed to cancel Printoteca order for Shopify ${shopifyOrderId}:`,
            err && err.message ? err.message : err,
          );
        }
      })();

      return res.status(200).send('OK');
    } catch (err) {
      console.error('Error handling orders-cancelled webhook', err);
      return res.status(500).send('Error');
    }
  },
);

// -----------------------------------------------------
// Queue sending the order to Printoteca with a delay
// (gives Teeinblue time to generate designs)
// -----------------------------------------------------
function queueSendOrderToPrintoteca(order) {
  const delayMs = Number(process.env.PRINTOTECA_RETRY_DELAY_MS || 300000); // default 5 minutes
  const waitSec = Math.round(delayMs / 1000);

  console.log(
    `Waiting ${waitSec} seconds before sending Shopify order ${order.id} to Printoteca...`,
  );

  setTimeout(async () => {
    try {
      await sendOrderToPrintoteca(order);
    } catch (err) {
      console.error(
        `Error sending Shopify order ${order.id} to Printoteca:`,
        err && err.message ? err.message : err,
      );
    }
  }, delayMs);
}

// -----------------------------------------------------
// Tracking job endpoint (for Cron-job.org)
// -----------------------------------------------------
app.get('/jobs/pull-printoteca-tracking', async (req, res) => {
  try {
    const jobToken = process.env.JOB_SECRET;

    if (jobToken && req.query.token !== jobToken) {
      return res.status(401).send('Unauthorized');
    }

    const result = await pollPrintotecaTrackingOnce();
    return res.json(result || { synced: 0, errors: 0 });
  } catch (err) {
    console.error('Tracking job error', err);
    return res.status(500).send('Error');
  }
});

// -----------------------------------------------------
// Manual “resync this order from Printoteca” endpoint
// -----------------------------------------------------
app.get('/admin/printoteca-sync/:orderId', async (req, res) => {
  try {
    const jobToken = process.env.JOB_SECRET;

    if (jobToken && req.query.token !== jobToken) {
      return res.status(401).send('Unauthorized');
    }

    const shopifyOrderId = req.params.orderId;
    const pOrder = await resyncSingleShopifyOrderFromPrintoteca(shopifyOrderId);

    if (!pOrder) {
      return res.status(404).json({
        ok: false,
        message:
          'No Printoteca order found for this Shopify order (check pod.printoteca_order_id metafield)',
      });
    }

    return res.json({
      ok: true,
      printotecaOrderId: pOrder.id,
      status: pOrder.status,
    });
  } catch (err) {
    console.error('Manual resync error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Gateway listening on port ${port}`);
});
