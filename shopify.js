// shopify.js
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;           // e.g. hugs-mugs-2.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;   // Admin API access token
const API_VERSION = '2024-07';                   // adjust when needed

if (!SHOP || !TOKEN) {
  console.warn('Shopify shop or token not configured');
}

function shopifyClient() {
  return axios.create({
    baseURL: `https://${SHOP}/admin/api/${API_VERSION}/`,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    timeout: 15000
  });
}

async function getShopifyOrder(orderId) {
  const client = shopifyClient();
  const res = await client.get(`orders/${orderId}.json`, {
    params: { fields: 'id,fulfillments,line_items,fulfillment_status,tags' }
  });
  return res.data.order;
}

function orderHasTracking(order, trackingNumber) {
  if (!order.fulfillments) return false;
  for (const f of order.fulfillments) {
    if (!f) continue;
    if (Array.isArray(f.tracking_numbers) && f.tracking_numbers.includes(trackingNumber)) {
      return true;
    }
    if (f.tracking_number === trackingNumber) return true;
  }
  return false;
}

async function createShopifyFulfillment(
  order,
  trackingNumber,
  trackingCompany = 'Printoteca',
  lineItemsOverride
) {
  const client = shopifyClient();

  let lineItems;
  if (Array.isArray(lineItemsOverride) && lineItemsOverride.length) {
    lineItems = lineItemsOverride;
  } else {
    // Fallback: fulfill all items
    lineItems = order.line_items.map(li => ({
      id: li.id,
      quantity: li.quantity
    }));
  }

  if (!lineItems.length) {
    console.log(`No line items to fulfill for order ${order.id}`);
    return null;
  }

  const body = {
    fulfillment: {
      notify_customer: true,
      tracking_number: trackingNumber,
      tracking_company: trackingCompany,
      line_items: lineItems
    }
  };

  const res = await client.post(`orders/${order.id}/fulfillments.json`, body);
  return res.data.fulfillment;
}

/**
 * Ensure there's a fulfillment with this tracking number for the
 * relevant SKUs (Printoteca items) on a Shopify order.
 */
async function ensureFulfillmentWithTracking(
  shopifyOrderId,
  trackingNumber,
  trackingCompany = 'Printoteca',
  printotecaItems
) {
  const order = await getShopifyOrder(shopifyOrderId);

  if (orderHasTracking(order, trackingNumber)) {
    console.log(
      `Order ${shopifyOrderId} already has fulfillment with tracking ${trackingNumber}, skipping`
    );
    return { status: 'already_exists' };
  }

  // If we know exactly which items Printoteca fulfilled, match by SKU
  let lineItemsForFulfillment = null;
  if (Array.isArray(printotecaItems) && printotecaItems.length) {
    const skuQtyMap = {};

    for (const pItem of printotecaItems) {
      const sku = pItem.pn;
      const qty = Number(pItem.quantity) || 0;
      if (!sku || !qty) continue;
      if (!skuQtyMap[sku]) skuQtyMap[sku] = 0;
      skuQtyMap[sku] += qty;
    }

    lineItemsForFulfillment = [];

    for (const li of order.line_items) {
      const sku = li.sku;
      if (!sku || !skuQtyMap[sku]) continue;

      const qtyToFulfill = Math.min(li.quantity, skuQtyMap[sku]);
      if (qtyToFulfill > 0) {
        lineItemsForFulfillment.push({
          id: li.id,
          quantity: qtyToFulfill
        });
      }
    }
  }

  const fulfillment = await createShopifyFulfillment(
    order,
    trackingNumber,
    trackingCompany,
    lineItemsForFulfillment
  );

  if (!fulfillment) {
    return { status: 'no_items' };
  }

  console.log(`Created fulfillment ${fulfillment.id} on order ${shopifyOrderId}`);
  return { status: 'created', fulfillmentId: fulfillment.id };
}

// ---- POD status tagging ----

const POD_STATUS_TAGS = [
  'POD: in production',
  'POD: printing',
  'POD: shipped',
  'POD: delivered'
];

/**
 * Set a single POD status tag on an order.
 * - Removes any existing POD: ... tags
 * - Adds newTag (if provided)
 */
async function setPodStatusTag(orderId, newTag) {
  const client = shopifyClient();

  // Get current tags
  const res = await client.get(`orders/${orderId}.json`, {
    params: { fields: 'id,tags' }
  });

  let tags = [];
  const current = res.data.order.tags;
  if (current && typeof current === 'string') {
    tags = current
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
  }

  // Remove all POD: ... tags
  tags = tags.filter(t => !POD_STATUS_TAGS.includes(t));

  // Add newTag if provided
  if (newTag && !tags.includes(newTag)) {
    tags.push(newTag);
  }

  const tagsString = tags.join(', ');

  await client.put(`orders/${orderId}.json`, {
    order: {
      id: orderId,
      tags: tagsString
    }
  });

  console.log(`Set POD status tag for order ${orderId} => [${tagsString}]`);

  return tagsString;
}

module.exports = {
  shopifyClient,
  getShopifyOrder,
  ensureFulfillmentWithTracking,
  setPodStatusTag
};
