require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const PRINTOTECA_API_BASE = process.env.PRINTOTECA_API_BASE;
const PRINTOTECA_SECRET_KEY = process.env.PRINTOTECA_SECRET_KEY;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const VERIFY_SHOPIFY_WEBHOOK = (req) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const calculatedHmac = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('base64');
  return hmac === calculatedHmac;
};

// Handle paid order webhook
app.post('/shopify/order-paid', async (req, res) => {
  if (!VERIFY_SHOPIFY_WEBHOOK(req)) {
    return res.status(403).send('Invalid webhook signature');
  }

  const orderData = req.body;

  try {
    // Check if the vendor is Printoteca, and if so, send to Printoteca
    if (orderData.vendor === 'Printoteca') {
      const designLink = orderData.line_items[0].properties?.design_url;  // Get the Teeinblue design link from order properties
      const orderId = orderData.id;
      const shippingMethod = process.env.DEFAULT_SHIPPING_METHOD;

      // Create order in Printoteca API
      await sendOrderToPrintoteca(orderData, designLink, orderId, shippingMethod);
    }

    res.status(200).send('Order received');
  } catch (error) {
    console.error('Error handling order:', error);
    res.status(500).send('Error');
  }
});

// Handle order cancellation webhook
app.post('/shopify/order-cancelled', async (req, res) => {
  if (!VERIFY_SHOPIFY_WEBHOOK(req)) {
    return res.status(403).send('Invalid webhook signature');
  }

  const orderData = req.body;

  try {
    // Cancel order in Printoteca
    if (orderData.vendor === 'Printoteca') {
      await cancelOrderInPrintoteca(orderData.id);
    }

    res.status(200).send('Order cancelled');
  } catch (error) {
    console.error('Error handling cancellation:', error);
    res.status(500).send('Error');
  }
});

// Function to send order to Printoteca
const sendOrderToPrintoteca = async (orderData, designLink, orderId, shippingMethod) => {
  const orderPayload = {
    brandName: process.env.PRINTOTECA_BRAND_NAME,
    comment: 'Test order.',
    shipping_address: {
      firstName: orderData.shipping_address.first_name,
      lastName: orderData.shipping_address.last_name,
      company: orderData.shipping_address.company,
      address1: orderData.shipping_address.address1,
      address2: orderData.shipping_address.address2,
      city: orderData.shipping_address.city,
      county: orderData.shipping_address.province,
      postcode: orderData.shipping_address.zip,
      country: orderData.shipping_address.country,
      phone1: orderData.shipping_address.phone,
    },
    shipping: {
      shippingMethod,
    },
    order_id: orderId,
    items: [
      {
        sku: orderData.line_items[0].sku,  // Match this with the SKU in Printoteca
        quantity: orderData.line_items[0].quantity,
        designUrl: designLink,  // Teeinblue design link
        fulfillment_key: 'position_value',  // Fulfillment key sent as position value
      },
    ],
  };

  try {
    const response = await axios.post(
      `https://api.printoteca.com/v1/orders`,
      orderPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.PRINTOTECA_SECRET_KEY}`,
        },
      }
    );

    console.log('Order sent to Printoteca:', response.data);
  } catch (error) {
    console.error('Error sending order to Printoteca:', error);
    throw new Error('Printoteca API error');
  }
};

// Function to cancel order in Printoteca
const cancelOrderInPrintoteca = async (orderId) => {
  try {
    const response = await axios.delete(
      `https://api.printoteca.com/v1/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PRINTOTECA_SECRET_KEY}`,
        },
      }
    );

    console.log('Order cancelled in Printoteca:', response.data);
  } catch (error) {
    console.error('Error cancelling order in Printoteca:', error);
    throw new Error('Printoteca API error');
  }
};

app.listen(process.env.PORT || 3000, () => {
  console.log('Server is running');
});
