const axios = require('axios');
const crypto = require('crypto');

// Use PRINTOTECA_APP_ID for constructing API base URL
const PRINTOTECA_API_BASE = 'https://printoteca.ro';  // You can change this if needed

// Function to cancel Printoteca order by Shopify order
async function cancelPrintotecaOrder(shopifyOrder) {
  const externalId = `shopify:${shopifyOrder.id}`;

  const printotecaOrder = await findPrintotecaOrderByExternalId(externalId);

  if (!printotecaOrder) {
    console.log(`No Printoteca order found for ${externalId}`);
    return;
  }

  const resp = await deletePrintotecaOrderById(printotecaOrder.id);
  console.log(`Cancelled Printoteca order ${printotecaOrder.id} for external_id=${externalId}`, resp);
}

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
    comment: "Test order.",  // Optional, you can pass this dynamically
    shipping_address,
    shipping: {
      shippingMethod
    },
    items
  };

  // Optional fields can be added if they exist
  if (shopifyOrder.comment) {
    body.comment = shopifyOrder.comment;
  }
  if (shopifyOrder.shipping_lines && shopifyOrder.shipping_lines[0].title) {
    body.shipping.shippingMethod = shopifyOrder.shipping_lines[0].title;
  }

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

// Function to sign the post body (for Printoteca API)
function signPostBody(bodyString, secretKey) {
  return sha1Hex(bodyString + secretKey);  // Signature generation logic
}

// New Mapping Functions

// Maps the Shopify order's shipping address to Printoteca format
function mapShippingAddress(shopifyOrder) {
  const address = shopifyOrder.shipping_address;
  return {
    firstName: address.first_name || '',
    lastName: address.last_name || '',
    company: address.company || '',
    address1: address.address1 || '',
    address2: address.address2 || '',
    city: address.city || '',
    county: address.province || '',  // Or map another field if necessary
    postcode: address.zip || '',
    country: address.country || '',
    phone1: address.phone || ''
  };
}

// Maps the Shopify order's shipping method to Printoteca format
function mapShippingMethod(shopifyOrder) {
  const shippingLine = shopifyOrder.shipping_lines && shopifyOrder.shipping_lines[0];
  return shippingLine ? shippingLine.title : "Standard";  // Default to "Standard" if no title exists
}

// Maps the Shopify line items to the items expected by Printoteca
function mapLineItemsToPrintotecaItems(shopifyOrder) {
  return shopifyOrder.line_items.map(item => ({
    pn: item.sku,  // Part number / SKU
    quantity: item.quantity,
    retailPrice: item.price,
    description: item.title,
    label: {
      type: "printed",  // Static example
      name: "ink-label"  // Static example
    },
    designs: {
      front: "https://example.com/front-image.png",  // Optional, make it dynamic if needed
      back: "https://example.com/back-image.png"   // Optional, make it dynamic if needed
    }
  }));
}

module.exports = {
  sendOrderToPrintoteca,
  cancelPrintotecaOrder,  // Exported function
  findPrintotecaOrderByExternalId,
  deletePrintotecaOrderById
};
