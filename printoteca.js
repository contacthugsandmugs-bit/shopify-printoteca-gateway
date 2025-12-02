const axios = require('axios');
const crypto = require('crypto');

const PRINTOTECA_API_BASE = 'https://printoteca.ro';

// ---- Helpers to extract Teeinblue design URLs from line item properties ----
function extractTeeinblueDesigns(lineItem) {
  const designs = {};
  if (!Array.isArray(lineItem.properties)) return designs;

  for (const prop of lineItem.properties) {
    if (!prop || !prop.name) continue;
    if (prop.name.startsWith('_tib_design_link')) {
      // First link -> front, second -> back
      if (!designs.front) designs.front = prop.value;
      else if (!designs.back) designs.back = prop.value;
    }
  }

  return designs;
}

// ---- Map Shopify order → Printoteca fields ----
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
  if (title.includes('recorded') || title.includes('signed')) return 'recorded';
  return 'regular';
}

function mapLineItemsToPrintotecaItems(shopifyOrder) {
  const items = [];

  for (const li of shopifyOrder.line_items) {
    // basic routing: all SKUs go to Printoteca, and SKU == Printoteca pn
    const pn = li.sku;
    if (!pn) {
      console.warn('Line item without SKU, skipping', li.id);
      continue;
    }

    const designs = extractTeeinblueDesigns(li);

    const printotecaItem = {
      pn,
      quantity: li.quantity,
      retailPrice: Number(li.price),
      description: li.name,
      designs: {}
    };

    if (designs.front) printotecaItem.designs.front = designs.front;
    if (designs.back) printotecaItem.designs.back = designs.back;

    items.push(printotecaItem);
  }

  return items;
}

// ---- Signature helpers (Printoteca / Inkthreadable-style) ----
function signPostBody(bodyString, secretKey) {
  return crypto
    .createHash('sha1')
    .update(bodyString + secretKey)
    .digest('hex');
}

function signGetQuery(queryStringWithoutSignature, secretKey) {
  return crypto
    .createHash('sha1')
    .update(queryStringWithoutSignature + secretKey)
    .digest('hex');
}

// ---- Create order in Printoteca ----
async function sendOrderToPrintoteca(shopifyOrder) {
  const appId = process.env.PRINTOTECA_APP_ID;
  const secretKey = process.env.PRINTOTECA_SECRET_KEY;
  const brandName = process.env.PRINTOTECA_BRAND_NAME || '';

  if (!appId || !secretKey) {
    throw new Error('Printoteca AppId/SecretKey not configured');
  }

  const shipping_address = mapShippingAddress(shopifyOrder);
  const shippingMethod = mapShippingMethod(shopifyOrder);
  const items = mapLineItemsToPrintotecaItems(shopifyOrder);

  if (!items.length) {
    throw new Error('No items mapped to Printoteca for order ' + shopifyOrder.id);
  }

  // external_id used later to map back to Shopify order
  const externalId = `shopify:${shopifyOrder.id}`;

  const body = {
    external_id: externalId,
    brandName: brandName,
    comment: `Shopify order ${shopifyOrder.name || shopifyOrder.id}`,
    shipping_address,
    shipping: {
      shippingMethod
    },
    items
  };

  const bodyString = JSON.stringify(body);
  const signature = signPostBody(bodyString, secretKey);

  const url = `${PRINTOTECA_API_BASE}/api/orders.php?AppId=${encodeURIComponent(
    appId
  )}&Signature=${signature}`;

  console.log('Sending order to Printoteca', { url, externalId });

  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  return response;
}

// ---- List recent Printoteca orders for tracking sync ----
async function listRecentPrintotecaOrders(daysBack = 14) {
  const appId = process.env.PRINTOTECA_APP_ID;
  const secretKey = process.env.PRINTOTECA_SECRET_KEY;
  if (!appId || !secretKey) {
    throw new Error('Printoteca AppId/SecretKey not configured');
  }

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams();
  params.append('AppId', appId);
  params.append('format', 'json');
  params.append('created_at_min', since);
  params.append('limit', '250');

  const bodyString = params.toString(); // everything before Signature
  const signature = signGetQuery(bodyString, secretKey);
  params.append('Signature', signature);

  const url = `${PRINTOTECA_API_BASE}/api/orders.php?${params.toString()}`;

  const res = await axios.get(url, {
    headers: { Accept: 'application/json' },
    timeout: 15000
  });

  const data = res.data;

  let orders;
  if (Array.isArray(data)) orders = data;
  else if (Array.isArray(data.orders)) orders = data.orders;
  else if (Array.isArray(data.data)) orders = data.data;
  else {
    console.error('Unexpected Printoteca orders response format');
    return [];
  }

  return orders;
}

module.exports = {
  sendOrderToPrintoteca,
  listRecentPrintotecaOrders
};
