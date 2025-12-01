const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;           // e.g. my-store.myshopify.com
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
    params: { fields: 'id,fulfillments,line_items,fulfillment_status' }
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

async function createShopifyFulfillment(order, trackingNumber, trackingCompany = 'Printoteca') {
  const client = shopifyClient();

  // Simple: fulfill all line items in this order
  const lineItems = order.line_items.map(li => ({
    id: li.id,
    quantity: li.quantity
  }));

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

async function ensureFulfillmentWithTracking(
  shopifyOrderId,
  trackingNumber,
  trackingCompany = 'Printoteca'
) {
  const order = await getShopifyOrder(shopifyOrderId);

  if (orderHasTracking(order, trackingNumber)) {
    console.log(
      `Order ${shopifyOrderId} already has fulfillment with tracking ${trackingNumber}, skipping`
    );
    return { status: 'already_exists' };
  }

  const fulfillment = await createShopifyFulfillment(order, trackingNumber, trackingCompany);
  console.log(`Created fulfillment ${fulfillment.id} on order ${shopifyOrderId}`);
  return { status: 'created', fulfillmentId: fulfillment.id };
}

module.exports = {
  getShopifyOrder,
  ensureFulfillmentWithTracking
};
