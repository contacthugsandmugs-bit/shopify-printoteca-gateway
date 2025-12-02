const axios = require('axios');
const crypto = require('crypto');
const PRINTOTECA_API_BASE = 'https://printoteca.ro';

// Function to fetch recent Printoteca orders based on a time range
async function listRecentPrintotecaOrders(daysBack = 14) {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  return listPrintotecaOrders({ created_at_min: since });
}

// Function to list all Printoteca orders
async function listPrintotecaOrders(params = {}) {
  const { appId, secretKey } = getAuthConfig();
  const qs = new URLSearchParams();
  qs.append('AppId', appId);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) qs.append(key, value);
  });

  const signature = sha1Hex(qs.toString() + secretKey);
  qs.append('Signature', signature);

  const url = `${PRINTOTECA_API_BASE}/api/orders.php?${qs.toString()}`;
  const res = await axios.get(url, {
    headers: { Accept: 'application/json' },
    timeout: 20000
  });

  const data = res.data;
  return Array.isArray(data.orders) ? data.orders : [];
}

// Basic auth + signing helpers
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

// Extract Teeinblue design links from the line item properties
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

// Map Shopify order to Printoteca fields
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

// Map Shopify line items to Printoteca item format
function mapLineItemsToPrintotecaItems(shopifyOrder) {
  const items = [];

  for (const li of shopifyOrder.line_items) {
    const pn = li.sku;
    console.log(`DEBUG: Extracted SKU from Shopify: ${pn}`);
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

// Generate the signature for POST requests to Printoteca API
function signPostBody(bodyString, secretKey) {
  return crypto.createHash('sha1').update(bodyString + secretKey).digest('hex');
}

// Generate the signature for GET requests to Printoteca API
function signGetQuery(queryStringWithoutSignature, secretKey) {
  return crypto.createHash('sha1').update(queryStringWithoutSignature + secretKey).digest('hex');
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

  // Creating the order body to send to Printoteca
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

  // Log the order body to see exactly what is being sent to Printoteca
  console.log('DEBUG: Sending order body to Printoteca:', JSON.stringify(body, null, 2));

  const bodyString = JSON.stringify(body);
  const signature = signPostBody(bodyString, secretKey);

  const url = `${PRINTOTECA_API_BASE}/api/orders.php?AppId=${encodeURIComponent(appId)}&Signature=${signature}`;

  console.log('DEBUG: URL for Printoteca request:', url);

  try {
    const response = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    console.log('DEBUG: Printoteca response:', JSON.stringify(response.data, null, 2));

    return response.data; // Return response from Printoteca
  } catch (error) {
    console.error('Printoteca error:', error.response ? error.response.data : error.message);
    throw new Error('Failed to send order to Printoteca');
  }
}


// Export necessary functions
module.exports = {
  sendOrderToPrintoteca,
  listRecentPrintotecaOrders
};
