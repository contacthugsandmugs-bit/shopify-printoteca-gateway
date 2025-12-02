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

// simple health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Shopify webhook needs raw body for HMAC verification (paid)
app.use(
  '/webhooks/shopify/orders-paid',
  bodyParser.raw({ type: 'application/json' })
);

// Shopify webhook needs raw body for HMAC verification (cancelled)
app.use(
  '/webhooks/shopify/orders-cancelled',
  bodyParser.raw({ type: 'application/json' })
);

// -----------------------------------------------------
// Shopify orders-paid webhook (UNCHANGED logic)
// -----------------------------------------------------
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
      return res.status(200).send('Ignored');
    }

    const order = JSON.parse(rawBody.toString('utf8'));
    console.log(`Received paid order ${order.id} / ${order.name}`);

    // Start Printoteca flow in the background (do NOT await)
    sendOrderToPrintotecaWithRetry(order);

    // Immediately reply OK to Shopify so webhook doesn't fail
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling orders-paid webhook', err);
    return res.status(500).send('Error');
  }
});

// -----------------------------------------------------
// NEW: Shopify orders-cancelled webhook (A)
// -----------------------------------------------------
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
      return res.status(200).send('Ignored');
    }

    const order = JSON.parse(rawBody.toString('utf8'));
    const shopifyOrderId = order.id;

    console.log(
      `Received cancelled order ${shopifyOrderId} / ${order.name} – cancelling at Printoteca`
    );

    // Run cancellation in background – don't block Shopify
    (async () => {
      try {
        await cancelPrintotecaOrderFromShopifyOrderId(shopifyOrderId);
      } catch (err) {
        console.error(
          `Error cancelling Printoteca order for Shopify order ${shopifyOrderId}:`,
          err && err.message ? err.message : err
        );
      }
    })();

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling orders-cancelled webhook', err);
    return res.status(500).send('Error');
  }
});

// -----------------------------------------------------
// Verify Shopify webhook HMAC (same for both webhooks)
// -----------------------------------------------------
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

// -----------------------------------------------------
// Retry logic for Printoteca with 5-minute initial delay
// (original working logic – kept as-is)
// -----------------------------------------------------
async function sendOrderToPrintotecaWithRetry(order, attempt = 1) {
  const maxAttempts = Number(process.env.PRINTOTECA_MAX_ATTEMPTS || 5);
  const delayMs = Number(process.env.PRINTOTECA_RETRY_DELAY_MS || 300000);
  const waitSec = Math.round(delayMs / 1000);

  const doSend = async () => {
    try {
      const resp = await sendOrderToPrintoteca(order);
      console.log(
        `Sent order ${order.id} to Printoteca on attempt ${attempt}, response:`,
        resp
      );
    } catch (err) {
      const msg = err.response?.data || err.message || '';
      const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);

      console.error(
        `Error sending order ${order.id} to Printoteca on attempt ${attempt}:`,
        msgStr
      );

      const isDesignUrlError = msgStr.includes('Design url is not valid');

      if (isDesignUrlError && attempt < maxAttempts) {
        console.log(
          `Design probably not ready yet, will retry in ${waitSec} seconds...`
        );
        setTimeout(() => {
          sendOrderToPrintotecaWithRetry(order, attempt + 1);
        }, delayMs);
      } else {
        console.log('Not retrying this order any further.');
      }
    }
  };

  if (attempt === 1) {
    console.log(
      `Waiting ${waitSec} seconds before FIRST send to Printoteca for order ${order.id}...`
    );
    setTimeout(() => {
      doSend();
    }, delayMs);
  } else {
    await doSend();
  }
}

// -----------------------------------------------------
// tracking job endpoint (for cron / manual runs)
// -----------------------------------------------------
app.get('/jobs/pull-printoteca-tracking', async (req, res) => {
  try {
    const jobToken = process.env.JOB_SECRET;
    if (jobToken && req.query.token !== jobToken) {
      return res.status(401).send('Unauthorized');
    }

    const result = await pollPrintotecaTrackingOnce();
    return res.json(result);
  } catch (err) {
    console.error('Tracking job error', err);
    return res.status(500).send('Error');
  }
});

// -----------------------------------------------------
// NEW: manual "resync this order from Printoteca" (C)
// GET /admin/printoteca-sync/:orderId?token=JOB_SECRET
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
