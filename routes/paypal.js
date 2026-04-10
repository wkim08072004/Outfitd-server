const express = require('express');
const router = express.Router();

const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';

async function getAccessToken() {
  const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET).toString('base64');
  const res = await fetch(PAYPAL_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  return data.access_token;
}

// Create a PayPal order and return approval URL
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const accessToken = await getAccessToken();
    const orderRes = await fetch(PAYPAL_BASE + '/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: currency || 'USD',
            value: amount.toFixed(2)
          }
        }],
        application_context: {
          return_url: req.headers.origin || 'https://outfitd.co',
          cancel_url: (req.headers.origin || 'https://outfitd.co') + '?paypal_cancel=1',
          brand_name: 'OUTFITD',
          user_action: 'PAY_NOW'
        }
      })
    });
    const order = await orderRes.json();
    const approvalLink = order.links && order.links.find(l => l.rel === 'approve');
    if (!approvalLink) {
      console.error('PayPal order error:', JSON.stringify(order));
      return res.status(500).json({ error: 'Could not create PayPal order' });
    }
    res.json({ approval_url: approvalLink.href, order_id: order.id });
  } catch (err) {
    console.error('PayPal create-order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Capture a PayPal order after user approves
router.post('/capture-order', async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });
    const accessToken = await getAccessToken();
    const captureRes = await fetch(PAYPAL_BASE + '/v2/checkout/orders/' + order_id + '/capture', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      }
    });
    const capture = await captureRes.json();
    if (capture.status === 'COMPLETED') {
      res.json({ success: true, order: capture });
    } else {
      res.status(400).json({ error: 'Payment not completed', status: capture.status });
    }
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
