const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Create a PaymentIntent
router.post('/create-intent', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    if (!amount || amount < 50) {
      return res.status(400).json({ error: 'Invalid amount (minimum 50 cents)' });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: currency || 'usd',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ client_secret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe create-intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
