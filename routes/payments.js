const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Create a PaymentIntent for embedded Stripe Payment Element
router.post('/create-intent', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    if (!amount || amount < 50) {
      return res.status(400).json({ error: 'Minimum charge is $0.50' });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: currency || 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { user_id: req.session?.userId || 'guest' }
    });
    res.json({ client_secret: paymentIntent.client_secret });
  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Confirm payment and finalize order
router.post('/confirm-payment', async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) {
      return res.status(400).json({ error: 'Missing payment_intent_id' });
    }
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (paymentIntent.status === 'succeeded') {
      res.json({ success: true, status: paymentIntent.status });
    } else {
      res.status(400).json({ error: 'Payment not completed', status: paymentIntent.status });
    }
  } catch (err) {
    console.error('Confirm payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
