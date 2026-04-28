// ═══════════════════════════════════════════════════════════════
// subscriptions.js — Stripe subscription routes
// Drop into /Users/eshapatel/outfitd-server/routes/subscriptions.js
// Add to server.js: app.use('/api/subscriptions', require('./routes/subscriptions'));
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Tier → Stripe Price ID mapping ──
// Member is the free default tier — no Stripe Product needed.
// Insider is $9.99/mo. Legend was removed in the launch-prep pivot.
const TIER_PRICES = {
  insider: process.env.STRIPE_INSIDER_PRICE_ID,
};

// ═══════════════════════════════════════════════════════════════
// POST /api/subscriptions/checkout
// Creates a Stripe Checkout Session for subscription, returns URL
// ═══════════════════════════════════════════════════════════════
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { tier } = req.body;
    const priceId = TIER_PRICES[tier];
    if (!priceId) return res.status(400).json({ error: 'Invalid subscription tier' });

    const userId = req.user.id;

    // Get or create Stripe customer
    const { data: userRecord } = await supabase
      .from('users')
      .select('stripe_customer_id, email')
      .eq('id', userId)
      .single();

    let customerId = userRecord?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userRecord?.email,
        metadata: { outfitd_user_id: userId },
      });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { outfitd_user_id: userId, tier },
      success_url: `${process.env.FRONTEND_URL}?subscription_success=${tier}`,
      cancel_url: `${process.env.FRONTEND_URL}?subscription_cancelled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Subscription checkout error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/subscriptions/portal
// Creates a Stripe Customer Portal session, returns URL
// ═══════════════════════════════════════════════════════════════
router.get('/portal', requireAuth, async (req, res) => {
  try {
    const { data: userRecord } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .single();

    if (!userRecord?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found — subscribe first' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: userRecord.stripe_customer_id,
      return_url: process.env.FRONTEND_URL,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    return res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/subscriptions/status
// Returns current subscription status from DB
// ═══════════════════════════════════════════════════════════════
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('users')
      .select('subscription, subscription_expires_at')
      .eq('id', req.user.id)
      .single();

    return res.json({
      tier: data?.subscription || 'free',
      expires_at: data?.subscription_expires_at || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

module.exports = router;
