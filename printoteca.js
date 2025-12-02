// printoteca.js
const axios = require('axios');
const crypto = require('crypto');
const {
  addOrderTag,
  appendOrderNote,
  getPrintotecaOrderIdMetafield,
  setPrintotecaOrderIdMetafield,
} = require('./shopify');

const {
  PRINTOTECA_APP_ID,
  PRINTOTECA_SECRET_KEY,
  PRINTOTECA_BRAND_NAME,
  DEFAULT_SHIPPING_METHOD,
} = process.env;

const PRINTOTECA_MAX_ATTEMPTS = Number(process.env.PRINTOTECA_MAX_ATTEMPTS || 5);
const PRINTOTECA_RETRY_DELAY_MS = Number(process.env.PRINTOTECA_RETRY_DELAY_MS || 300000);

// IMPORTANT: set this in Render if it's different
const PRINTOTECA_BASE_URL = process.env.PRINTOTECA_BASE_URL || 'https://www.printoteca.com';

// ---------- low-level helpers (signing) ----------

function computeSignature(payload) {
  if (!PRINTOTECA_SECRET_KEY) {
    throw new Error('PRINTOTECA_SECRET_KEY not configured');
  }

  return crypto
    .createHash('sha1')
    .update(payload + PRINTOTECA_SECRET_KEY, 'utf8')
    .digest('base64');
}

// GET with AppId + Signature in query
async function printotecaGet(path, params = {}) {
  if (!PRINTOTECA_APP_ID) {
    throw new Error('PRINTOTECA_APP_ID not configured');
  }

  const query = new URLSearchParams({ AppId: PRINTOTECA_APP_ID, ...params });
  const payloadForSignature = query.toString(); // everything after ?

  const signature = computeSignature(payloadForSignature);
  query.append('Signature', signature);

  const url = `${PRINTOTECA_BASE_URL}${path}?${query.toString()}`;

  const res = await axios.get(url, {
    headers: { Accept: 'application/json' },
    timeout: 20000,
  });

  return res.data;
}

// POST with AppId + Signature in query
async function printotecaPost(path, body) {
  if (!PRINTOTECA_APP_ID) {
    throw new Error('PRINTOTECA_APP_ID not configured');
  }

  const json = JSON.stringify(body);
  const signature = computeSignature(json);

  const url = `${PRINTOTECA_BASE_URL}${path}?AppId=${encodeURIComponent(
    PRINTOTECA_APP_ID,
  )}&Signature=${encodeURIComponent(signature)}`;

  const res = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 20000,
  });

  return res.data;
}

// DELETE (Inkthreadable docs say DELETE but example uses GET; this follows docs)
async function printotecaDelete(path, params = {}) {
  if (!PRINTOTECA_APP_ID) {
    throw new Error('PRINTOTECA_APP_ID not configured');
  }

  const query = new URLSearchParams({ AppId: PRINTOTECA_APP_ID, ...params });
  const payloadForSignature = query.toString();
  const signature = computeSignature(payloadForSignature);
  query.append('Signature', signature);

  const url = `${PRINTOTECA_BASE_URL}${path}?${query.toString()}`;

  const res = await axios.delete(url, {
    headers: { Accept: 'application/json' },
    timeout: 20000,
  });

  return res.data;
}

// ---------- high level API wrappers ----------

async function getPrintotecaOrderById(id) {
  return printotecaGet('/api/order.php', { id, format: 'json' });
}

async function listPrintotecaOrders(params = {}) {
  // used by tracking job: created_at_min/max, status, limit, page, etc.
  return printotecaGet('/api/orders.php', { format: 'json', ...params });
}

async function deletePrintotecaOrder(id) {
  // Only allowed for non-paid orders according to docs
  return printotecaDelete('/api/orders.php', { id });
}

function extractPrintotecaErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (err.response && err.response.data) {
    const data = err.response.data;
    if (typeof data === 'string') return data;
    if (data.message) return data.message;
    if (data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    return JSON.stringify(data);
  }
  return err.message || 'Unknown error';
}

// ---------- main order-create (with retries + metafield) ----------

// NOTE: this is a *reference* implementation; if you already have a working
// sendOrderToPrintotecaWithRetry, you can just copy the “error handling” part
// and the metafield saving into your existing function instead.

async function sendOrderToPrintotecaWithRetry(shopifyOrder, buildPayloadFn) {
  if (!buildPayloadFn) {
    throw new Error('sendOrderToPrintotecaWithRetry requires a buildPayloadFn(shopifyOrder)');
  }

  const shopifyOrderId = shopifyOrder.id;
  let lastError;

  for (let attempt = 1; attempt <= PRINTOTECA_MAX_ATTEMPTS; attempt++) {
    try {
      const payload = buildPayloadFn(shopifyOrder);

      // ensure brand & shipping
      payload.brandName = payload.brandName || PRINTOTECA_BRAND_NAME;
      payload.shipping = payload.shipping || {};
      payload.shipping.shippingMethod =
        payload.shipping.shippingMethod || DEFAULT_SHIPPING_METHOD || 'regular';

      // ALWAYS set external_id so we can match later
      payload.external_id = payload.external_id || `shopify:${shopifyOrderId}`;

      const data = await printotecaPost('/api/orders.php', payload);

      const printotecaId = data.id || data.order?.id;
      if (!printotecaId) {
        throw new Error(`Printoteca response did not contain id: ${JSON.stringify(data)}`);
      }

      // --- B. Save Printoteca order id into Shopify metafield ---
      await setPrintotecaOrderIdMetafield(shopifyOrderId, printotecaId);

      return data;
    } catch (err) {
      lastError = err;
      console.error(
        `[Printoteca] Send attempt ${attempt} failed for Shopify order ${shopifyOrderId}:`,
        extractPrintotecaErrorMessage(err),
      );

      if (attempt < PRINTOTECA_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, PRINTOTECA_RETRY_DELAY_MS));
      }
    }
  }

  // ---- E. Surface errors to Shopify as tag + note ----
  await handlePrintotecaSupplierError(shopifyOrderId, lastError);
  throw lastError;
}

// ---------- E. Error surfacing helper ----------

async function handlePrintotecaSupplierError(shopifyOrderId, error) {
  const message = extractPrintotecaErrorMessage(error);

  try {
    await addOrderTag(shopifyOrderId, 'POD: supplier error');
  } catch (err) {
    console.error('[Printoteca] failed to tag supplier error', err.message);
  }

  try {
    await appendOrderNote(shopifyOrderId, `Printoteca error: ${message}`);
  } catch (err) {
    console.error('[Printoteca] failed to append error note', err.message);
  }
}

// ---------- A. Cancel / delete when Shopify order is cancelled ----------

async function cancelPrintotecaOrderFromShopifyOrderId(shopifyOrderId) {
  const printotecaId = await getPrintotecaOrderIdMetafield(shopifyOrderId);

  if (!printotecaId) {
    // older orders created before metafield logic – warn in note so you see it in admin
    await appendOrderNote(
      shopifyOrderId,
      'Printoteca: cancellation webhook received but no pod.printoteca_order_id metafield was found. Cancel manually in Printoteca if needed.',
    );
    return;
  }

  let printotecaOrder;
  try {
    printotecaOrder = await getPrintotecaOrderById(printotecaId);
  } catch (err) {
    console.error(
      `[Printoteca] Failed to fetch order ${printotecaId} before cancelling:`,
      extractPrintotecaErrorMessage(err),
    );
  }

  // Optionally skip cancelling if already shipped
  if (printotecaOrder && printotecaOrder.shipping && printotecaOrder.shipping.shiped_at) {
    await appendOrderNote(
      shopifyOrderId,
      `Printoteca: order ${printotecaId} already shipped at ${printotecaOrder.shipping.shiped_at}, API cancel may not be possible.`,
    );
  }

  try {
    await deletePrintotecaOrder(printotecaId);
    await addOrderTag(shopifyOrderId, 'POD: cancelled at supplier');
    await appendOrderNote(
      shopifyOrderId,
      `Printoteca: order ${printotecaId} cancelled via API because Shopify order was cancelled.`,
    );
  } catch (err) {
    console.error(
      `[Printoteca] Failed to cancel order ${printotecaId}:`,
      extractPrintotecaErrorMessage(err),
    );
    await handlePrintotecaSupplierError(shopifyOrderId, err);
  }
}

// ---------- C. Helper to fetch Printoteca order given Shopify order id ----------

async function getPrintotecaOrderForShopifyOrder(shopifyOrderId) {
  const printotecaId = await getPrintotecaOrderIdMetafield(shopifyOrderId);
  if (!printotecaId) return null;

  return getPrintotecaOrderById(printotecaId);
}

// ---------- F. Optional: SKU validation ----------

// Put real SKUs here once and forget about them ;-)
const VALID_PRINTOTECA_SKUS = new Set([
  // 'GILD5000-BLACK-S',
  // 'GILD5000-BLACK-M',
  // add your real Printoteca SKUs here
]);

function isValidPrintotecaSku(sku) {
  if (!sku) return false;
  if (VALID_PRINTOTECA_SKUS.size === 0) return true; // validation disabled until you fill the set
  return VALID_PRINTOTECA_SKUS.has(sku);
}

/**
 * Validate SKUs for a Shopify order and return:
 * {
 *   validLineItems: [], // to actually send to Printoteca
 *   invalidSkus: []     // for tagging / notes
 * }
 */
function splitValidInvalidPrintotecaLineItems(order) {
  const validLineItems = [];
  const invalidSkus = [];

  for (const li of order.line_items || []) {
    // If you route by vendor, uncomment the next 2 lines:
    // if (li.vendor !== 'Printoteca') continue;

    if (!isValidPrintotecaSku(li.sku)) {
      invalidSkus.push(li.sku || '(no SKU)');
      continue;
    }
    validLineItems.push(li);
  }

  return { validLineItems, invalidSkus };
}

module.exports = {
  printotecaGet,
  printotecaPost,
  printotecaDelete,
  getPrintotecaOrderById,
  listPrintotecaOrders,
  deletePrintotecaOrder,
  extractPrintotecaErrorMessage,
  sendOrderToPrintotecaWithRetry,
  handlePrintotecaSupplierError,
  cancelPrintotecaOrderFromShopifyOrderId,
  getPrintotecaOrderForShopifyOrder,
  splitValidInvalidPrintotecaLineItems,
  isValidPrintotecaSku,
};
