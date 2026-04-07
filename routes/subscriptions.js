const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) { res.status(401).json({ error: 'Invalid session' }); }
}

// POST /api/subscriptions/checkout — create Stripe Checkout Session
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ error: 'Price ID required' });

    const { data: user } = await supabase
      .from('users').select('id, email, stripe_customer_id').eq('id', req.user.userId).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Create or reuse Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.FRONTEND_URL || 'https://outfitd.co') + '?subscription=success',
      cancel_url: (process.env.FRONTEND_URL || 'https://outfitd.co') + '?subscription=cancelled',
      metadata: { userId: user.id }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// POST /api/subscriptions/portal — customer portal for managing subscription
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('stripe_customer_id').eq('id', req.user.userId).single();

    if (!user || !user.stripe_customer_id)
      return res.status(400).json({ error: 'No active subscription' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: process.env.FRONTEND_URL || 'https://outfitd.co'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Portal failed' });
  }
});

// GET /api/subscriptions/status — get current subscription from Stripe
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('subscription, stripe_customer_id').eq('id', req.user.userId).single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.stripe_customer_id)
      return res.json({ subscription: 'free', active: false });

    // Check live Stripe data
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripe_customer_id, status: 'active', limit: 1
    });

    if (subscriptions.data.length === 0)
      return res.json({ subscription: 'free', active: false });

    const sub = subscriptions.data[0];
    const priceId = sub.items.data[0].price.id;

    // Map price ID to tier
    let tier = 'free';
    if (priceId === process.env.STRIPE_INSIDER_PRICE_ID) tier = 'insider';
    else if (priceId === process.env.STRIPE_LEGEND_PRICE_ID) tier = 'legend';

    // Sync to database
    if (user.subscription !== tier) {
      await supabase.from('users').update({ subscription: tier }).eq('id', req.user.userId);
    }

    res.json({ subscription: tier, active: true, currentPeriodEnd: sub.current_period_end });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

module.exports = router;
