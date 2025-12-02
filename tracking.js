// tracking.js
const { listRecentPrintotecaOrders } = require('./printoteca');
const { ensureFulfillmentWithTracking, setPodStatusTag } = require('./shopify');

function mapPrintotecaStatusToPodTag(order) {
  const statusRaw = order.status || '';
  const status = String(statusRaw).toLowerCase();
  const shipping = order.shipping || {};
  const tracking = shipping.trackingNumber || shipping.tracking_number;
  const shippedAtRaw = shipping.shiped_at || shipping.shipped_at;

  const POD_TAGS = {
    inProduction: 'POD: in production',
    printing: 'POD: printing',
    shipped: 'POD: shipped',
    delivered: 'POD: delivered'
  };

  // If we have a tracking number, the order has been shipped
  if (tracking) {
    const deliveredAfterDays = Number(process.env.POD_DELIVERED_AFTER_DAYS || 7);
    if (shippedAtRaw) {
      const t = Date.parse(shippedAtRaw);
      if (!Number.isNaN(t)) {
        const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
        if (days >= deliveredAfterDays) {
          return POD_TAGS.delivered;
        }
      }
    }
    return POD_TAGS.shipped;
  }

  // No tracking yet – use production statuses
  if (['printing', 'quality control', 'stock allocation'].includes(status)) {
    return POD_TAGS.printing;
  }

  if (['received', 'in progress', 'paid'].includes(status)) {
    return POD_TAGS.inProduction;
  }

  return null;
}

async function pollPrintotecaTrackingOnce() {
  const days = Number(process.env.PRINTOTECA_TRACKING_WINDOW_DAYS || 14);

  const orders = await listRecentPrintotecaOrders(days);
  console.log(`Printoteca tracking poll: received ${orders.length} orders`);

  const results = [];

  for (const po of orders) {
    try {
      const externalId = po.external_id || po.externalId;
      if (!externalId || !externalId.startsWith('shopify:')) continue;

      const shopifyIdStr = externalId.split(':')[1];
      if (!shopifyIdStr) continue;

      const shopifyOrderId = shopifyIdStr.trim();

      const shipping = po.shipping || po.shipping_details || {};
      const tracking = shipping.trackingNumber || shipping.tracking_number;
      const printotecaItems = po.items || po.order_items || [];

      let fulfillmentResult = null;
      if (tracking) {
        console.log(
          `Syncing tracking ${tracking} from Printoteca order ${po.id} -> Shopify order ${shopifyOrderId}`
        );

        fulfillmentResult = await ensureFulfillmentWithTracking(
          shopifyOrderId,
          tracking,
          'Printoteca',
          printotecaItems
        );
      }

      const podTag = mapPrintotecaStatusToPodTag(po);
      let tagsAfter = null;
      if (podTag) {
        tagsAfter = await setPodStatusTag(shopifyOrderId, podTag);
      }

      results.push({
        printotecaId: po.id,
        shopifyOrderId,
        tracking,
        podTag,
        fulfillmentResult
      });
    } catch (err) {
      console.error('Error syncing Printoteca order', po.id, err.message);
      results.push({ printotecaId: po.id, error: err.message });
    }
  }

  return { processed: results.length, results };
}

module.exports = { pollPrintotecaTrackingOnce };
