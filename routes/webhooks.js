const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /api/webhooks/stripe
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = req.body;
    }
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send('Webhook Error');
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const priceId = sub.items.data[0].price.id;
        const status = sub.status;

        let tier = 'free';
        if (status === 'active') {
          if (priceId === process.env.STRIPE_INSIDER_PRICE_ID) tier = 'insider';
          else if (priceId === process.env.STRIPE_LEGEND_PRICE_ID) tier = 'legend';
        }

        await supabase.from('users').update({ subscription: tier }).eq('stripe_customer_id', customerId);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('users').update({ subscription: 'free' }).eq('stripe_customer_id', sub.customer);
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription') {
          // Award bonus Style Points on first subscription
          const userId = session.metadata.userId;
          if (userId) {
            const { data: user } = await supabase.from('users').select('store_credits').eq('id', userId).single();
            if (user) {
              await supabase.from('users').update({ store_credits: (user.store_credits || 0) + 1000 }).eq('id', userId);
              await supabase.from('transactions').insert({
                user_id: userId, type: 'subscription_bonus', currency: 'store_credits',
                amount: 1000, description: 'Subscription signup bonus'
              });
            }
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

module.exports = router;
