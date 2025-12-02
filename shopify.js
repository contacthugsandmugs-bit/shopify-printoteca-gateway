const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP; // e.g. hugs-mugs-2.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';

if (!SHOP || !TOKEN) {
  console.warn('Shopify: SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN not configured');
}

function shopifyClient() {
  return axios.create({
    baseURL: `https://${SHOP}/admin/api/${API_VERSION}/`,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    timeout: 20000
  });
}

async function getShopifyOrder(orderId) {
  const client = shopifyClient();
  const res = await client.get(`orders/${orderId}.json`);
  return res.data.order;
}

function orderHasTracking(order, trackingNumber) {
  if (!order.fulfillments) return false;

  for (const f of order.fulfillments) {
    if (!f) continue;

    if (Array.isArray(f.tracking_numbers) && f.tracking_numbers.includes(trackingNumber)) {
      return true;
    }

    if (f.tracking_number === trackingNumber) {
      return true;
    }
  }

  return false;
}

async function createShopifyFulfillment(order, trackingNumber, trackingCompany = 'Printoteca') {
  const client = shopifyClient();

  const lineItems = (order.line_items || []).map((li) => ({
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
      `Shopify: order ${shopifyOrderId} already has fulfillment with tracking ${trackingNumber}, skipping`
    );
    return { status: 'already_exists' };
  }

  const fulfillment = await createShopifyFulfillment(order, trackingNumber, trackingCompany);
  console.log(`Shopify: created fulfillment ${fulfillment.id} on order ${shopifyOrderId}`);
  return { status: 'created', fulfillmentId: fulfillment.id };
}

module.exports = {
  getShopifyOrder,
  ensureFulfillmentWithTracking
};
