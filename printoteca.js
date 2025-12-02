const axios = require('axios');
const crypto = require('crypto');

const PRINTOTECA_API_BASE = 'https://printoteca.ro';

// ---------------------------
// Basic auth + signing helpers
// ---------------------------

function getAuthConfig() {
  const appId = process.env.PRINTOTECA_APP_ID;
  const secretKey = process.env.PRINTOTECA_SECRET_KEY;

  if (!appId || !secretKey) {
    throw new Error('PRINTOTECA_APP_ID or PRINTOTECA_SECRET_KEY not configured');
  }

  return { appId, secretKey };
}

function sha1Hex(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

// GET: body = query string *without* Signature
function buildSignedGetUrl(path, params = {}) {
  const { appId, secretKey } = getAuthConfig();

  const qs = new URLSearchParams();
  qs.append('AppId', appId);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.append(key, String(value));
  }

  const qsWithoutSignature = qs.toString();
  const signature = sha1Hex(qsWithoutSignature + secretKey);
  const fullQuery = `${qsWithoutSignature}&Signature=${signature}`;

  return `${PRINTOTECA_API_BASE}${path}?${fullQuery}`;
}

// POST: body = JSON, signature = sha1(body + secretKey)
function buildSignedPostRequest(path, body) {
  const { appId, secretKey } = getAuthConfig();
  const bodyString = JSON.stringify(body);
  const signature = sha1Hex(bodyString + secretKey);

  const qs = new URLSearchParams();
  qs.append('AppId', appId);
  qs.append('Signature', signature);

  const url = `${PRINTOTECA_API_BASE}${path}?${qs.toString()}`;

  return { url, bodyString };
}

// ---------------------------
// Low-level Printoteca client
// ---------------------------

async function createPrintotecaOrder(orderBody) {
  const { url, bodyString } = buildSignedPostRequest('/api/orders.php', orderBody);

  const res = await axios.post(url, bodyString, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    timeout: 20000
  });

  return res.data;
}

async function listPrintotecaOrders(params = {}) {
  const finalParams = { ...params };

  if (!finalParams.format) finalParams.format = 'json';
  if (!finalParams.limit) finalParams.limit = 250;

  const url = buildSignedGetUrl('/api/orders.php', finalParams);

  const res = await axios.get(url, {
    headers: { Accept: 'application/json' },
    timeout: 20000
  });

  const data = res.data;

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.orders)) return data.orders;
  if (Array.isArray(data.data)) return data.data;

  console.warn('Printoteca listPrintotecaOrders: unexpected response format');
  return [];
}

async function listRecentPrintotecaOrders(daysBack = 14) {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  return listPrintotecaOrders({ created_at_min: since });
}

async function getPrintotecaOrderById(id) {
  const url = buildSignedGetUrl('/api/order.php', {
    id,
    format: 'json'
  });

  const res = await axios.get(url, {
    headers: { Accept: 'application/json' },
    timeout: 15000
  });

  return res.data;
}

async function countPrintotecaOrders(params = {}) {
  const url = buildSignedGetUrl('/api/orders/count.php', params);

  const res = await axios.get(url, {
    timeout: 15000
  });

  return res.data;
}

// Delete order by id (Printoteca docs show GET /api/orders.php?id=... for delete)
async function deletePrintotecaOrderById(id) {
  const url = buildSignedGetUrl('/api/orders.php', { id });

  const res = await axios.get(url, {
    timeout: 15000
  });

  return res.data;
}

async function findPrintotecaOrderByExternalId(externalId, daysBack = 30) {
  const orders = await listRecentPrintotecaOrders(daysBack);
  return (
    orders.find(
      (o) =>
        o.external_id === externalId ||
        o.externalId === externalId
    ) || null
  );
}

// ---------------------------
// Teeinblue helpers
// ---------------------------

function extractTeeinblueDesigns(lineItem) {
  const designs = {};
  if (!Array.isArray(lineItem.properties)) return designs;

  for (const prop of lineItem.properties) {
    if (!prop || !prop.name) continue;
    if (prop.name.startsWith('_tib_design_link')) {
      if (!designs.front) designs.front = prop.value;
      else if (!designs.back) designs.back = prop.value;
    }
  }

  return designs;
}

// ---------------------------
// Mapping Shopify → Printoteca
// ---------------------------

function mapShippingAddress(shopifyOrder) {
  const addr = shopifyOrder.shipping_address || {};

  return {
    firstName: addr.first_name || '',
    lastName: addr.last_name || '',
    company: addr.company || '',
    address1: addr.address1 || '',
    address2: addr.address2 || '',
    city: addr.city || '',
    county: addr.province || '',
    postcode: addr.zip || '',
    country: addr.country || '',
    phone1: addr.phone || ''
  };
}

function mapShippingMethod(shopifyOrder) {
  const defaultMethod = process.env.DEFAULT_SHIPPING_METHOD || 'courier';
  const shippingLines = shopifyOrder.shipping_lines || [];
  if (!shippingLines.length) return defaultMethod;

  const title = (shippingLines[0].title || '').toLowerCase();

  if (title.includes('courier') || title.includes('express')) return 'courier';
  if (title.includes('recorded') || title.includes('tracked') || title.includes('signed')) {
    return 'recorded';
  }

  return 'regular';
}

function mapLineItemsToPrintotecaItems(shopifyOrder) {
  const items = [];
  const lineItems = shopifyOrder.line_items || [];

  for (const li of lineItems) {
    const pn = li.sku;
    if (!pn) {
      console.warn('Printoteca: line item without SKU, skipping', li.id);
      continue;
    }

    const designs = extractTeeinblueDesigns(li);

    const item = {
      pn,
      quantity: li.quantity,
      retailPrice: Number(li.price),
      description: li.name,
      designs: {}
    };

    if (designs.front) item.designs.front = designs.front;
    if (designs.back) item.designs.back = designs.back;

    items.push(item);
  }

  return items;
}

function mapShopifyOrderToPrintotecaOrder(shopifyOrder) {
  const shipping_address = mapShippingAddress(shopifyOrder);
  const shippingMethod = mapShippingMethod(shopifyOrder);
  const items = mapLineItemsToPrintotecaItems(shopifyOrder);

  if (!items.length) {
    throw new Error(`Printoteca: no items mapped from Shopify order ${shopifyOrder.id}`);
  }

  const brandName = process.env.PRINTOTECA_BRAND_NAME || '';
  const external_id = `shopify:${shopifyOrder.id}`;

  return {
    external_id,
    brandName,
    comment: `Shopify order ${shopifyOrder.name || shopifyOrder.id}`,
    shipping_address,
    shipping: {
      shippingMethod
    },
    items
  };
}

async function createPrintotecaOrderFromShopifyOrder(shopifyOrder) {
  const body = mapShopifyOrderToPrintotecaOrder(shopifyOrder);
  const data = await createPrintotecaOrder(body);
  return data;
}

// ---------------------------
// Exports
// ---------------------------

module.exports = {
  createPrintotecaOrder,
  listPrintotecaOrders,
  listRecentPrintotecaOrders,
  getPrintotecaOrderById,
  deletePrintotecaOrderById,
  countPrintotecaOrders,
  findPrintotecaOrderByExternalId,
  mapShopifyOrderToPrintotecaOrder,
  createPrintotecaOrderFromShopifyOrder
};
