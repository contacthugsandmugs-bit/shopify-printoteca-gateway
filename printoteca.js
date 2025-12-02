const axios = require('axios');
const crypto = require('crypto');
const PRINTOTECA_API_BASE = 'https://printoteca.ro';

// Function to find Printoteca order by external ID (Shopify order ID)
async function findPrintotecaOrderByExternalId(externalId) {
  const url = buildSignedGetUrl('/api/orders.php', { external_id: externalId });
  const res = await axios.get(url, { timeout: 15000 });

  return res.data.orders ? res.data.orders[0] : null;
}

// Function to delete a Printoteca order by ID
async function deletePrintotecaOrderById(orderId) {
  const url = buildSignedGetUrl('/api/orders.php', { id: orderId });
  const res = await axios.get(url, { timeout: 15000 });

  return res.data;
}

// Function to generate signed URL (for API requests)
function buildSignedGetUrl(path, params = {}) {
  const { appId, secretKey } = getAuthConfig();

  const qs = new URLSearchParams();
  qs.append('AppId', appId);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) qs.append(key, value);
  }

  const signature = sha1Hex(qs.toString() + secretKey);
  qs.append('Signature', signature);

  return `${PRINTOTECA_API_BASE}${path}?${qs.toString()}`;
}

function getAuthConfig() {
  const appId = process.env.PRINTOTECA_APP_ID;
  const secretKey = process.env.PRINTOTECA_SECRET_KEY;

  if (!appId || !secretKey) {
    throw new Error('Printoteca AppId/SecretKey not configured');
  }

  return { appId, secretKey };
}

function sha1Hex(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

// Create order in Printoteca
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

  const url = `${PRINTOTECA_API_BASE}/api/orders.php?AppId=${encodeURIComponent(appId)}&Signature=${signature}`;

  console.log('Sending order to Printoteca', { url, externalId });

  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  return response.data;
}

module.exports = {
  sendOrderToPrintoteca,
  cancelPrintotecaOrder,
  findPrintotecaOrderByExternalId,
  deletePrintotecaOrderById
};
