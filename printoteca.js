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

const PRINTOTECA_MAX_ATTEMPTS = Number(
  process.env.PRINTOTECA_MAX_ATTEMPTS || 5,
);
const PRINTOTECA_RETRY_DELAY_MS = Number(
  process.env.PRINTOTECA_RETRY_DELAY_MS || 300000,
);

// You can override this in Render with PRINTOTECA_BASE_URL if they ever change domain
const PRINTOTECA_BASE_URL =
  process.env.PRINTOTECA_BASE_URL || 'https://www.printoteca.com';

// -----------------------------------------------------
// Low-level helpers (signing + HTTP) – from Printoteca
// docs: each request uses AppId + Signature. 
// -----------------------------------------------------
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

  const query = new URLSearchParams({
    AppId: PRINTOTECA_APP_ID,
    ...params,
  });

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

// DELETE
async function printotecaDelete(path, params = {}) {
  if (!PRINTOTECA_APP_ID) {
    throw new Error('PRINTOTECA_APP_ID not configured');
  }

  const query = new URLSearchParams({
    AppId: PRINTOTECA_APP_ID,
    ...params,
  });

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

// -----------------------------------------------------
// High-level Printoteca API wrappers
// -----------------------------------------------------
async function getPrintotecaOrderById(id) {
  return printotecaGet('/api/order.php', { id, format: 'json' });
}

async function listPrintotecaOrders(params = {}) {
  // used by tracking job: created_at_min/max, status, limit, page, etc.
  return printotecaGet('/api/orders.php', {
    format: 'json',
    ...params,
  });
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
    if (data.error) {
      return typeof data.error === 'string'
        ? data.error
        : JSON.stringify(data.error);
    }

    return JSON.stringify(data);
  }

  return err.message || 'Unknown error';
}

// -----------------------------------------------------
// F. SKU validation helpers
// -----------------------------------------------------

// Put real SKUs here once and forget about them ;-)
const VALID_PRINTOTECA_SKUS = new Set([
  // 'STTU755-WHITE-S',
  // 'STTU755-WHITE-M',
  // add your real Printoteca SKUs here to have validation ON
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
    // If in future you route by vendor, uncomment:
    // if (li.vendor !== 'Printoteca') continue;

    if (!isValidPrintotecaSku(li.sku)) {
      invalidSkus.push(li.sku || '(no SKU)');
      continue;
    }

    validLineItems.push(li);
  }

  return { validLineItems, invalidSkus };
}

// -----------------------------------------------------
// B. Build Printoteca payload from Shopify order
//    (shipping_address + items + Teeinblue designs)
// -----------------------------------------------------

function extractTeeinblueDesignLink(lineItem) {
  if (!Array.isArray(lineItem.properties)) return null;

  const designProp = lineItem.properties.find(
    (p) => p && p.name === '_tib_design_link' && p.value,
  );

  return designProp ? String(designProp.value) : null;
}

function buildPrintotecaOrderPayloadFromShopify(order, validLineItemsOverride) {
  const shipping = order.shipping_address || order.billing_address || {};

  const shippingAddress = {
    // Field names taken from Printoteca docs 
    firstName: shipping.first_name || '',
    lastName: shipping.last_name || '',
    company: shipping.company || '',
    address1: shipping.address1 || '',
    address2: shipping.address2 || '',
    city: shipping.city || '',
    county: shipping.province || '',
    postcode: shipping.zip || '',
    country: shipping.country || '',
    phone1: shipping.phone || order.phone || '',
    phone2: '',
    phone3: '',
    vatNumber: '', // you can wire this later from a metafield if needed
  };

  const lineItems = validLineItemsOverride || order.line_items || [];

  const items = lineItems.map((li) => {
    const designUrl = extractTeeinblueDesignLink(li);

    // Build a simple description from variant title + public properties
    const descParts = [];
    if (li.variant_title) descParts.push(li.variant_title);

    if (Array.isArray(li.properties)) {
      for (const p of li.properties) {
        if (!p || !p.name) continue;
        if (p.name.startsWith('_')) continue; // skip Teeinblue/internal props
        if (!p.value) continue;
        descParts.push(`${p.name}: ${p.value}`);
      }
    }

    const description = descParts.join(' | ');

    const item = {
      pn: li.sku, // Printoteca product code (you set your SKUs to match) 
      title: li.title,
      quantity: li.quantity,
      retailPrice: String(li.price), // what the customer paid
      description,
    };

    if (designUrl) {
      // Printoteca expects an object of sides -> URL (e.g. front/back) 
      item.designs = {
        front: designUrl,
      };
    }

    return item;
  });

  return {
    // external_id is set in sendOrderToPrintotecaWithRetry if missing
    brandName: PRINTOTECA_BRAND_NAME,
    shipping_address: shippingAddress,
    items,
  };
}

// -----------------------------------------------------
// main order-create with retries + metafield (A,B,E,F)
// -----------------------------------------------------

// Low-level function that actually talks to Printoteca & retries on error.
// You normally don't call this directly; use sendOrderToPrintoteca(order).
async function sendOrderToPrintotecaWithRetry(shopifyOrder, buildPayloadFn) {
  if (!buildPayloadFn) {
    throw new Error(
      'sendOrderToPrintotecaWithRetry requires a buildPayloadFn(shopifyOrder)',
    );
  }

  const shopifyOrderId = shopifyOrder.id;
  let lastError;

  for (let attempt = 1; attempt <= PRINTOTECA_MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = buildPayloadFn(shopifyOrder);

      // ensure brand & shipping
      payload.brandName = payload.brandName || PRINTOTECA_BRAND_NAME;
      payload.shipping = payload.shipping || {};
      payload.shipping.shippingMethod =
        payload.shipping.shippingMethod ||
        DEFAULT_SHIPPING_METHOD ||
        'regular';

      // ALWAYS set external_id so we can match later
      payload.external_id = payload.external_id || `shopify:${shopifyOrderId}`;

      const data = await printotecaPost('/api/orders.php', payload);

      const printotecaId = data.id || (data.order && data.order.id);
      if (!printotecaId) {
        throw new Error(
          `Printoteca response did not contain id: ${JSON.stringify(data)}`,
        );
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
        await new Promise((resolve) =>
          setTimeout(resolve, PRINTOTECA_RETRY_DELAY_MS),
        );
      }
    }
  }

  // ---- E. Surface errors to Shopify as tag + note ----
  await handlePrintotecaSupplierError(shopifyOrderId, lastError);
  throw lastError;
}

// High-level helper: this is what index.js calls on paid orders.
async function sendOrderToPrintoteca(shopifyOrder) {
  const shopifyOrderId = shopifyOrder.id;

  // 1) Validate SKUs
  const { validLineItems, invalidSkus } =
    splitValidInvalidPrintotecaLineItems(shopifyOrder);

  if (!validLineItems.length) {
    console.log(
      `[Printoteca] Shopify order ${shopifyOrderId} has no valid Printoteca line items; skipping.`,
    );
    return null;
  }

  if (invalidSkus.length) {
    try {
      await addOrderTag(shopifyOrderId, 'POD: unknown SKU');
      await appendOrderNote(
        shopifyOrderId,
        `Printoteca: these SKUs are not configured for Printoteca and were skipped: ${invalidSkus.join(
          ', ',
        )}`,
      );
    } catch (err) {
      console.error(
        '[Printoteca] Failed to tag/annotate order for unknown SKUs:',
        err && err.message,
      );
    }
  }

  // 2) Build payload only from valid line items
  const buildPayloadFn = (order) =>
    buildPrintotecaOrderPayloadFromShopify(order, validLineItems);

  // 3) Send with retries + metafield + error surfacing
  return sendOrderToPrintotecaWithRetry(shopifyOrder, buildPayloadFn);
}

// -----------------------------------------------------
// E. Error surfacing helper
// -----------------------------------------------------
async function handlePrintotecaSupplierError(shopifyOrderId, error) {
  const message = extractPrintotecaErrorMessage(error);

  try {
    await addOrderTag(shopifyOrderId, 'POD: supplier error');
  } catch (err) {
    console.error(
      '[Printoteca] failed to tag supplier error',
      err && err.message,
    );
  }

  try {
    await appendOrderNote(
      shopifyOrderId,
      `Printoteca error: ${message}`,
    );
  } catch (err) {
    console.error(
      '[Printoteca] failed to append error note',
      err && err.message,
    );
  }
}

// -----------------------------------------------------
// A. Cancel / delete when Shopify order is cancelled
// -----------------------------------------------------
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

  // Optionally warn if already shipped
  if (
    printotecaOrder &&
    printotecaOrder.shipping &&
    printotecaOrder.shipping.shiped_at
  ) {
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

// -----------------------------------------------------
// C. Helper to fetch Printoteca order given Shopify id
// -----------------------------------------------------
async function getPrintotecaOrderForShopifyOrder(shopifyOrderId) {
  const printotecaId = await getPrintotecaOrderIdMetafield(shopifyOrderId);
  if (!printotecaId) return null;
  return getPrintotecaOrderById(printotecaId);
}

module.exports = {
  // low level
  printotecaGet,
  printotecaPost,
  printotecaDelete,
  getPrintotecaOrderById,
  listPrintotecaOrders,
  deletePrintotecaOrder,
  extractPrintotecaErrorMessage,

  // order helpers
  sendOrderToPrintoteca,
  sendOrderToPrintotecaWithRetry,
  handlePrintotecaSupplierError,
  cancelPrintotecaOrderFromShopifyOrderId,
  getPrintotecaOrderForShopifyOrder,

  // SKU helpers
  splitValidInvalidPrintotecaLineItems,
  isValidPrintotecaSku,
};
