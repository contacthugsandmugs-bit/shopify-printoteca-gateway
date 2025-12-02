// printoteca.js
// ------------------------------------------------------------
// Handles Printoteca API communication for order creation,
// cancellation, status sync, and error surfacing.
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// ✅ Use the correct Printoteca domain (printoteca.ro)
// ------------------------------------------------------------
const PRINTOTECA_BASE_URL = process.env.PRINTOTECA_BASE_URL || 'https://printoteca.ro';

// ------------------------------------------------------------
// ✅ Correct SHA1 signature generator
// According to Printoteca's (Inkthreadable-style) API docs:
// Signature = SHA1(<payload or query> + SecretKey), HEX encoded
// ------------------------------------------------------------
function computeSignature(payload) {
  if (!PRINTOTECA_SECRET_KEY) {
    throw new Error('PRINTOTECA_SECRET_KEY not configured');
  }

  const toSign = payload + PRINTOTECA_SECRET_KEY;

  return crypto.createHash('sha1').update(toSign, 'utf8').digest('hex');
}

// ------------------------------------------------------------
// GET, POST, DELETE wrappers with signing
// ------------------------------------------------------------
async function printotecaGet(path, params = {}) {
  if (!PRINTOTECA_APP_ID) throw new Error('PRINTOTECA_APP_ID not configured');

  const query = new URLSearchParams({ AppId: PRINTOTECA_APP_ID, ...params });
  const payloadForSignature = query.toString();
  const signature = computeSignature(payloadForSignature);
  query.append('Signature', signature);

  const url = `${PRINTOTECA_BASE_URL}${path}?${query.toString()}`;
  const res = await axios.get(url, { headers: { Accept: 'application/json' }, timeout: 20000 });
  return res.data;
}

async function printotecaPost(path, body) {
  if (!PRINTOTECA_APP_ID) throw new Error('PRINTOTECA_APP_ID not configured');

  const json = JSON.stringify(body);
  const signature = computeSignature(json);

  const url = `${PRINTOTECA_BASE_URL}${path}?AppId=${encodeURIComponent(
    PRINTOTECA_APP_ID,
  )}&Signature=${encodeURIComponent(signature)}`;

  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 20000,
  });

  return res.data;
}

async function printotecaDelete(path, params = {}) {
  if (!PRINTOTECA_APP_ID) throw new Error('PRINTOTECA_APP_ID not configured');

  const query = new URLSearchParams({ AppId: PRINTOTECA_APP_ID, ...params });
  const payloadForSignature = query.toString();
  const signature = computeSignature(payloadForSignature);
  query.append('Signature', signature);

  const url = `${PRINTOTECA_BASE_URL}${path}?${query.toString()}`;
  const res = await axios.delete(url, { headers: { Accept: 'application/json' }, timeout: 20000 });
  return res.data;
}

// ------------------------------------------------------------
// Helper: extract Printoteca error messages
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// F. SKU validation helpers
// ------------------------------------------------------------
const VALID_PRINTOTECA_SKUS = new Set([
  // add SKUs here to activate validation, e.g.:
  // 'GILD5000-BLACK-S',
  // 'GILD5000-BLACK-M',
]);

function isValidPrintotecaSku(sku) {
  if (!sku) return false;
  if (VALID_PRINTOTECA_SKUS.size === 0) return true;
  return VALID_PRINTOTECA_SKUS.has(sku);
}

function splitValidInvalidPrintotecaLineItems(order) {
  const validLineItems = [];
  const invalidSkus = [];

  for (const li of order.line_items || []) {
    if (!isValidPrintotecaSku(li.sku)) {
      invalidSkus.push(li.sku || '(no SKU)');
      continue;
    }
    validLineItems.push(li);
  }

  return { validLineItems, invalidSkus };
}

// ------------------------------------------------------------
// Extract Teeinblue design URL from line item
// ------------------------------------------------------------
function extractTeeinblueDesignLink(lineItem) {
  if (!Array.isArray(lineItem.properties)) return null;
  const designProp = lineItem.properties.find(
    (p) => p && p.name === '_tib_design_link' && p.value,
  );
  return designProp ? String(designProp.value) : null;
}

// ------------------------------------------------------------
// Build Printoteca payload from a Shopify order
// ------------------------------------------------------------
function buildPrintotecaOrderPayloadFromShopify(order, validLineItemsOverride) {
  const shipping = order.shipping_address || order.billing_address || {};

  const shippingAddress = {
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
    vatNumber: '',
  };

  const lineItems = validLineItemsOverride || order.line_items || [];
  const items = lineItems.map((li) => {
    const designUrl = extractTeeinblueDesignLink(li);
    const descParts = [];

    if (li.variant_title) descParts.push(li.variant_title);
    if (Array.isArray(li.properties)) {
      for (const p of li.properties) {
        if (!p || !p.name) continue;
        if (p.name.startsWith('_')) continue;
        if (!p.value) continue;
        descParts.push(`${p.name}: ${p.value}`);
      }
    }

    const description = descParts.join(' | ');
    const item = {
      pn: li.sku,
      title: li.title,
      quantity: li.quantity,
      retailPrice: String(li.price),
      description,
    };

    if (designUrl) item.designs = { front: designUrl };
    return item;
  });

  return {
    brandName: PRINTOTECA_BRAND_NAME,
    shipping_address: shippingAddress,
    items,
  };
}

// ------------------------------------------------------------
// Main order-send with retries + metafield + error surfacing
// ------------------------------------------------------------
async function sendOrderToPrintotecaWithRetry(shopifyOrder, buildPayloadFn) {
  const shopifyOrderId = shopifyOrder.id;
  let lastError;

  for (let attempt = 1; attempt <= PRINTOTECA_MAX_ATTEMPTS; attempt++) {
    try {
      const payload = buildPayloadFn(shopifyOrder);

      payload.brandName = payload.brandName || PRINTOTECA_BRAND_NAME;
      payload.shipping = payload.shipping || {};
      payload.shipping.shippingMethod =
        payload.shipping.shippingMethod || DEFAULT_SHIPPING_METHOD || 'regular';
      payload.external_id = payload.external_id || `shopify:${shopifyOrderId}`;

      const data = await printotecaPost('/api/orders.php', payload);

      const printotecaId = data.id || (data.order && data.order.id);
      if (!printotecaId) throw new Error(`No id returned: ${JSON.stringify(data)}`);

      await setPrintotecaOrderIdMetafield(shopifyOrderId, printotecaId);
      console.log(`[Printoteca] Created order ${printotecaId} for Shopify ${shopifyOrderId}`);
      return data;
    } catch (err) {
      lastError = err;
      console.error(
        `[Printoteca] Send attempt ${attempt} failed for Shopify order ${shopifyOrderId}:`,
        extractPrintotecaErrorMessage(err),
      );
      if (attempt < PRINTOTECA_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, PRINTOTECA_RETRY_DELAY_MS));
      }
    }
  }

  await handlePrintotecaSupplierError(shopifyOrderId, lastError);
  throw lastError;
}

// ------------------------------------------------------------
// Public: called from index.js when Shopify order is paid
// ------------------------------------------------------------
async function sendOrderToPrintoteca(shopifyOrder) {
  const shopifyOrderId = shopifyOrder.id;
  const { validLineItems, invalidSkus } = splitValidInvalidPrintotecaLineItems(shopifyOrder);

  if (!validLineItems.length) {
    console.log(`[Printoteca] Shopify order ${shopifyOrderId} has no valid Printoteca SKUs`);
    return null;
  }

  if (invalidSkus.length) {
    try {
      await addOrderTag(shopifyOrderId, 'POD: unknown SKU');
      await appendOrderNote(
        shopifyOrderId,
        `Printoteca: unknown SKU(s) not sent: ${invalidSkus.join(', ')}`,
      );
    } catch (err) {
      console.error('[Printoteca] Failed tagging unknown SKUs', err.message);
    }
  }

  const buildPayloadFn = (order) =>
    buildPrintotecaOrderPayloadFromShopify(order, validLineItems);
  return sendOrderToPrintotecaWithRetry(shopifyOrder, buildPayloadFn);
}

// ------------------------------------------------------------
// E. Surface supplier errors back to Shopify
// -
