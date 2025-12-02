require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// Body parser middleware to handle raw Shopify webhook payload
app.use(bodyParser.raw({ type: 'application/json' }));

// Shopify Webhook for Order Creation
app.post('/webhook/shopify/order', async (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const rawBody = req.body;

    // Validate Shopify webhook signature
    if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
      return res.status(400).send('Invalid webhook');
    }

    const order = JSON.parse(rawBody.toString('utf8'));
    console.log('Received Shopify Order:', order);

    // Send the order to Printoteca
    await sendOrderToPrintoteca(order);

    res.status(200).send('Order processed');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Internal server error');
  }
});

// Verify Shopify webhook signature
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_SECRET;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  return hmacHeader === digest;
}

// Send order to Printoteca API
async function sendOrderToPrintoteca(order) {
  const apiUrl = 'https://printoteca.ro/api/orders'; // Adjust if Printoteca uses a different URL
  const data = {
    external_id: `shopify:${order.id}`,
    brandName: "Your Brand",
    comment: "Customer custom order",
    shipping_address: order.shipping_address, // Assuming shipping info is available in Shopify order
    items: order.line_items.map(item => ({
      pn: item.sku,
      quantity: item.quantity,
      retailPrice: item.price,
      description: item.title
    }))
  };

  // Send order data to Printoteca API
  const response = await axios.post(apiUrl, data, {
    headers: {
      'Authorization': `Bearer ${process.env.PRINTOTECA_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('Printoteca Response:', response.data);
}

// Start Express server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
