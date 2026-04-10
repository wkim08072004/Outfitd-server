const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Create a Stripe Connect account and return onboarding link
router.post('/onboard', async (req, res) => {
  try {
    const { email, seller_id } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    // Create a Connect Express account
    const account = await stripe.accounts.create({
      type: 'express',
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
    });

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://outfitd.co?stripe_connect_refresh=1',
      return_url: 'https://outfitd.co?stripe_connect_return=1&account_id=' + account.id,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url, account_id: account.id });
  } catch (err) {
    console.error('Stripe Connect onboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Check if a Connect account is fully onboarded
router.post('/status', async (req, res) => {
  try {
    const { account_id } = req.body;
    if (!account_id) return res.status(400).json({ error: 'Missing account_id' });

    const account = await stripe.accounts.retrieve(account_id);
    res.json({
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      email: account.email,
    });
  } catch (err) {
    console.error('Stripe Connect status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
