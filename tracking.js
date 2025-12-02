const { listRecentPrintotecaOrders } = require('./printoteca');
const { ensureFulfillmentWithTracking } = require('./shopify');

async function pollPrintotecaTrackingOnce() {
  const days = Number(process.env.PRINTOTECA_TRACKING_WINDOW_DAYS || 14);

  const orders = await listRecentPrintotecaOrders(days);
  console.log(`Printoteca tracking poll: received ${orders.length} orders`);

  const results = [];

  for (const po of orders) {
    try {
      const shipping = po.shipping || po.shipping_details || {};
      const tracking = shipping.trackingNumber || shipping.tracking_number;

      if (!tracking) continue;

      const externalId = po.external_id || po.externalId;
      if (!externalId || !externalId.startsWith('shopify:')) continue;

      const shopifyIdStr = externalId.split(':')[1];
      if (!shopifyIdStr) continue;

      const shopifyOrderId = shopifyIdStr.trim();
      console.log(
        `Syncing tracking ${tracking} from Printoteca order ${po.id} -> Shopify order ${shopifyOrderId}`
      );

      const result = await ensureFulfillmentWithTracking(
        shopifyOrderId,
        tracking,
        'Printoteca'
      );
      results.push({ printotecaId: po.id, shopifyOrderId, tracking, result });
    } catch (err) {
      console.error('Error syncing tracking for Printoteca order', po.id, err.message);
      results.push({ printotecaId: po.id, error: err.message });
    }
  }

  return { processed: results.length, results };
}

module.exports = { pollPrintotecaTrackingOnce };
