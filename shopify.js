// shopify.js
const axios = require('axios');

const SHOP = process.env.SHOPIFY_SHOP;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

if (!SHOP || !ACCESS_TOKEN) {
  console.warn('[shopify] Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN');
}

const shopify = axios.create({
  baseURL: `https://${SHOP}/admin/api/${API_VERSION}`,
  timeout: 15000,
  headers: {
    'X-Shopify-Access-Token': ACCESS_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

// ---- basic helpers ----

async function getOrder(orderId) {
  const res = await shopify.get(`/orders/${orderId}.json`);
  return res.data.order;
}

function parseTags(tagString) {
  if (!tagString) return [];
  return tagString
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

function buildTagString(tags) {
  const unique = Array.from(new Set(tags));
  return unique.join(', ');
}

// ---- TAGGING ----

async function addOrderTag(orderId, newTag) {
  const order = await getOrder(orderId);
  const tags = parseTags(order.tags);
  if (!tags.includes(newTag)) {
    tags.push(newTag);
  }

  await shopify.put(`/orders/${orderId}.json`, {
    order: {
      id: orderId,
      tags: buildTagString(tags),
    },
  });
}

async function replacePodStatusTag(orderId, newPodTag) {
  const order = await getOrder(orderId);
  let tags = parseTags(order.tags);

  // remove all POD: ... tags
  tags = tags.filter(tag => !tag.startsWith('POD:'));

  if (newPodTag) {
    tags.push(newPodTag);
  }

  await shopify.put(`/orders/${orderId}.json`, {
    order: {
      id: orderId,
      tags: buildTagString(tags),
    },
  });
}

// ---- NOTES ----

async function appendOrderNote(orderId, note) {
  const order = await getOrder(orderId);
  const existing = order.note || '';
  const prefix = existing ? `${existing}\n` : '';
  const stamp = new Date().toISOString().replace('T', ' ').replace(/\..+/, '');
  const newNote = `${prefix}[${stamp}] ${note}`;

  await shopify.put(`/orders/${orderId}.json`, {
    order: {
      id: orderId,
      note: newNote,
    },
  });
}

// ---- METAFIELDS ----

async function getOrderMetafields(orderId, namespace) {
  const params = namespace ? { namespace } : {};
  const res = await shopify.get(`/orders/${orderId}/metafields.json`, { params });
  return res.data.metafields || [];
}

async function getOrderMetafield(orderId, namespace, key) {
  const metafields = await getOrderMetafields(orderId, namespace);
  return metafields.find(mf => mf.key === key);
}

async function setOrderMetafield(orderId, namespace, key, value, type = 'single_line_text_field') {
  const body = {
    metafield: {
      namespace,
      key,
      value: String(value),
      type,
    },
  };

  try {
    // try create
    await shopify.post(`/orders/${orderId}/metafields.json`, body);
  } catch (err) {
    // if already exists, update instead
    if (err.response && err.response.status === 422) {
      const existing = await getOrderMetafield(orderId, namespace, key);
      if (!existing) throw err;

      await shopify.put(`/metafields/${existing.id}.json`, {
        metafield: {
          id: existing.id,
          value: String(value),
          type,
        },
      });
    } else {
      throw err;
    }
  }
}

// Specific helpers for Printoteca

async function setPrintotecaOrderIdMetafield(orderId, printotecaOrderId) {
  return setOrderMetafield(orderId, 'pod', 'printoteca_order_id', String(printotecaOrderId));
}

async function getPrintotecaOrderIdMetafield(orderId) {
  const mf = await getOrderMetafield(orderId, 'pod', 'printoteca_order_id');
  return mf ? mf.value : null;
}

async function setPrintotecaShippingCostMetafield(orderId, shippingPrice, currency) {
  if (shippingPrice == null) return;

  // numeric value (you can change to single_line_text_field if you prefer)
  await setOrderMetafield(orderId, 'pod', 'printoteca_shipping_cost', String(shippingPrice), 'number_decimal');
  if (currency) {
    await setOrderMetafield(orderId, 'pod', 'printoteca_shipping_currency', String(currency), 'single_line_text_field');
  }
}

module.exports = {
  shopify,
  getOrder,
  addOrderTag,
  replacePodStatusTag,
  appendOrderNote,
  getOrderMetafield,
  setOrderMetafield,
  setPrintotecaOrderIdMetafield,
  getPrintotecaOrderIdMetafield,
  setPrintotecaShippingCostMetafield,
};
