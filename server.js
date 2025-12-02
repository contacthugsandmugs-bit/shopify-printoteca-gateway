const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse incoming JSON requests
app.use(bodyParser.json());

// Handle Shopify Webhook
app.post('/webhooks/shopify/orders-paid', async (req, res) => {
  const orderData = req.body; // Shopify order data

  const designUrl = orderData.line_items[0].properties.TeeinblueUrl; // Example for Teeinblue URL

  try {
    const response = await fetch('https://api.printoteca.com/create-order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer YOUR_PRINTOTECA_API_KEY',
      },
      body: JSON.stringify({
        orderId: orderData.id,
        designUrl: designUrl,
        customerName: orderData.customer.name,
        shippingAddress: orderData.shipping_address,
        // other necessary fields from the order data
      }),
    });

    const data = await response.json();

    if (response.ok) {
      res.status(200).send('Order successfully sent to Printoteca');
    } else {
      res.status(500).send(`Error sending order to Printoteca: ${data.message}`);
    }
  } catch (error) {
    console.error('Error processing the order:', error);
    res.status(500).send('Error processing the order');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
