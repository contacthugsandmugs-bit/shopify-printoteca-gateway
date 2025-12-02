const { listRecentPrintotecaOrders } = require('./printoteca');
const { ensureFulfillmentWithTracking } = require('./shopify');

async function pollPrintotecaTrackingOnce() {
  const days = Number(process.env.PRINTOTECA_TRACKING_WINDOW_DAYS || 14);

  const orders = await listRecentPrintotecaOrders(days);
  console.log(`Tracking job: fetched ${orders.length} Printoteca orders`);

  const results = [];

  for (const po of orders) {
    try {
      const shipping = po.shipping || po.shipping_details || po.shipping_details || {};
      const tracking =
        shipping.trackingNumber ||
        shipping.tracking_number ||
        shipping.tracking_number1 ||
        shipping.trackingNumber1;

      if (!tracking) {
        continue;
      }

      const externalId = po.external_id || po.externalId;
      if (!externalId || !externalId.startsWith('shopify:')) {
        continue;
      }

      const shopifyOrderId = externalId.replace('shopify:', '');
      if (!shopifyOrderId) continue;

      console.log(
        `Tracking job: syncing tracking ${tracking} from Printoteca order ${po.id} to Shopify order ${shopifyOrderId}`
      );

      const result = await ensureFulfillmentWithTracking(shopifyOrderId, tracking, 'Printoteca');

      results.push({
        printotecaId: po.id,
        shopifyOrderId,
        tracking,
        result
      });
    } catch (err) {
      console.error(
        'Tracking job: error syncing tracking for Printoteca order',
        po.id,
        err.message
      );
      results.push({ printotecaId: po.id, error: err.message });
    }
  }

  return { processed: results.length, results };
}

module.exports = { pollPrintotecaTrackingOnce };
