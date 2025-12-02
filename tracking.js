// tracking.js
const {
  listPrintotecaOrders,
  getPrintotecaOrderForShopifyOrder,
} = require('./printoteca');
const {
  replacePodStatusTag,
  setPrintotecaShippingCostMetafield,
} = require('./shopify');

const TRACKING_WINDOW_DAYS = Number(process.env.PRINTOTECA_TRACKING_WINDOW_DAYS || 14);

// ---- D. status mapping (+ shipped / delivered) ----

function mapPrintotecaStatusToPodTag(printotecaOrder) {
  const status = (printotecaOrder.status || '').toLowerCase();
  const shipping = printotecaOrder.shipping || {};
  const hasTracking = Boolean(shipping.trackingNumber);
  const shippedAt = shipping.shiped_at || shipping.shipped_at; // some typos in older APIs

  // Extra statuses
  if (status === 'refunded') return 'POD: refunded';
  if (status === 'internal order query') return 'POD: on hold';

  // Shipped / delivered logic based on ship date
  if (hasTracking || shippedAt) {
    if (shippedAt) {
      const shippedDate = new Date(shippedAt);
      const daysSince =
        (Date.now() - shippedDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince >= TRACKING_WINDOW_DAYS) {
        return 'POD: delivered';
      }
    }
    return 'POD: shipped';
  }

  if (['stock allocation', 'printing', 'quality control'].includes(status)) {
    return 'POD: printing';
  }

  if (['received', 'in progress', 'paid'].includes(status)) {
    return 'POD: in production';
  }

  return null;
}

// Apply tag + shipping cost to one Shopify order
async function applyPrintotecaOrderToShopify(printotecaOrder) {
  const externalId = printotecaOrder.external_id || printotecaOrder.externalId;
  if (!externalId || !externalId.startsWith('shopify:')) {
    return;
  }
  const shopifyOrderId = externalId.replace('shopify:', '');

  const tag = mapPrintotecaStatusToPodTag(printotecaOrder);
  if (tag) {
    await replacePodStatusTag(shopifyOrderId, tag);
  }

  // ---- G. shipping cost metafield ----
  const summary = printotecaOrder.summary || {};
  if (summary.shippingPrice != null) {
    await setPrintotecaShippingCostMetafield(
      shopifyOrderId,
      summary.shippingPrice,
      summary.currency,
    );
  }

  // You can also call your existing "ensure fulfillment & tracking" function here,
  // using printotecaOrder.shipping.trackingNumber / shipped_at if you already have it.
}

// ---- Automatic cron sync (same idea as you already have) ----
// This is a reference implementation; if you already have /jobs/pull-printoteca-tracking,
// just call applyPrintotecaOrderToShopify() instead of your old tag logic.

async function syncRecentPrintotecaOrders() {
  const createdAtMin = new Date(Date.now() - TRACKING_WINDOW_DAYS * 86400000)
    .toISOString();

  let page = 1;
  const limit = 50;

  // Inkthreadable API does basic pagination by page + limit
  // Adjust if you're already using another strategy
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await listPrintotecaOrders({
      created_at_min: createdAtMin,
      limit,
      page,
    });

    const orders = Array.isArray(data.orders) ? data.orders : data;
    if (!orders || !orders.length) break;

    // In parallel but with simple throttling if you want
    for (const pOrder of orders) {
      try {
        await applyPrintotecaOrderToShopify(pOrder);
      } catch (err) {
        console.error(
          '[tracking] Failed to sync Printoteca order',
          pOrder.id,
          err.message,
        );
      }
    }

    if (orders.length < limit) break; // no more pages
    page += 1;
  }
}

// ---- C. Manual “resync this order” helper ----

async function resyncSingleShopifyOrderFromPrintoteca(shopifyOrderId) {
  const pOrder = await getPrintotecaOrderForShopifyOrder(shopifyOrderId);
  if (!pOrder) return false;

  await applyPrintotecaOrderToShopify(pOrder);
  return pOrder;
}

module.exports = {
  mapPrintotecaStatusToPodTag,
  applyPrintotecaOrderToShopify,
  syncRecentPrintotecaOrders,
  resyncSingleShopifyOrderFromPrintoteca,
};
