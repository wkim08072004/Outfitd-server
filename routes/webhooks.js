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

        // Subscription checkout
        if (session.mode === 'subscription') {
          // Award bonus Style Points on first subscription
          const userId = session.metadata.outfitd_user_id;
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

        // Marketplace order payment completed
        if (session.mode === 'payment' && session.metadata && session.metadata.order_id) {
          const orderId = session.metadata.order_id;
          const orderNumber = session.metadata.order_number;

          // Update order status
          await supabase.from('orders').update({
            status: 'awaiting_fulfillment',
            stripe_payment_intent_id: session.payment_intent,
            updated_at: new Date().toISOString(),
            hold_until: new Date(Date.now() + 75 * 24 * 60 * 60 * 1000).toISOString(),
          }).eq('id', orderId);

          // Award Style Points for purchase
          const { data: order } = await supabase.from('orders').select('subtotal, user_id').eq('id', orderId).single();
          if (order) {
            const { data: orderUser } = await supabase.from('users').select('subscription, op_balance').eq('id', order.user_id).single();
            const tierRate = (orderUser && orderUser.subscription === 'legend') ? 0.10
              : (orderUser && orderUser.subscription === 'insider') ? 0.07 : 0.05;
            const earnedPts = Math.round(order.subtotal * tierRate * 100);

            if (earnedPts > 0 && orderUser) {
              await supabase.from('users').update({
                op_balance: (orderUser.op_balance || 0) + earnedPts
              }).eq('id', order.user_id);

              await supabase.from('transactions').insert({
                user_id: order.user_id, type: 'purchase_reward', currency: 'store_credits',
                amount: earnedPts, description: 'Order ' + orderNumber + ': +' + earnedPts + ' Style Points'
              });
            }
          }
          console.log('[Order] ' + orderNumber + ' payment confirmed — awaiting fulfillment');
        }
        break;
      }

      case 'payment_intent.succeeded': {
        // Safety net for the inline Stripe Element flow: if the frontend
        // confirm-payment call never reaches us (browser closed, network
        // glitch right after Stripe success), record the order here.
        // Idempotent — skipped entirely if any row already exists for the PI.
        const intent = event.data.object;
        const piId = intent.id;
        const { data: existing } = await supabase
          .from('orders').select('id').eq('stripe_payment_id', piId).limit(1);
        if (existing && existing.length > 0) {
          console.log('[webhook] payment_intent.succeeded ' + piId + ' — already recorded, skipping');
          break;
        }
        // Identify the buyer via the Stripe Customer ID stashed on the user
        // row at first checkout. Without this we can't credit Style Points
        // or attribute the order — fall back to a placeholder row.
        let buyerId = null;
        let buyerOpBalance = 0;
        let buyerSubscription = 'free';
        if (intent.customer) {
          const { data: buyer } = await supabase
            .from('users')
            .select('id, op_balance, subscription')
            .eq('stripe_customer_id', intent.customer)
            .single();
          if (buyer) {
            buyerId = buyer.id;
            buyerOpBalance = buyer.op_balance || 0;
            buyerSubscription = buyer.subscription || 'free';
          }
        }
        const { error: webhookInsertErr } = await supabase.from('orders').insert({
          buyer_id: buyerId,
          seller_id: null,
          listing_id: null,
          total: intent.amount, // cents
          stripe_payment_id: piId,
          shipping_address: intent.shipping || null,
          status: buyerId ? 'paid' : 'paid_unrecorded',
        });
        if (webhookInsertErr) {
          console.error('[webhook] payment_intent.succeeded insert failed:',
            webhookInsertErr.code, webhookInsertErr.message);
          break;
        }
        console.warn('[webhook] payment_intent.succeeded ' + piId +
          ' — recorded via webhook (frontend confirm did not reach us)');
        // Best-effort Style Points award if we identified the buyer. Use the
        // PI amount as a proxy for subtotal — over-credits a buyer by a few
        // pts on the shipping/tax delta but never under-credits.
        if (buyerId) {
          const tierRate = buyerSubscription === 'legend' ? 0.10
            : buyerSubscription === 'insider' ? 0.07 : 0.05;
          const pointsAwarded = Math.round(intent.amount * tierRate);
          if (pointsAwarded > 0) {
            await supabase
              .from('users')
              .update({ op_balance: buyerOpBalance + pointsAwarded })
              .eq('id', buyerId);
            await supabase.from('transactions').insert({
              user_id: buyerId,
              type: 'purchase_reward',
              currency: 'op_balance',
              amount: pointsAwarded,
              description: 'Order reward (webhook): +' + pointsAwarded + ' Style Points',
            });
          }
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object;
        if (session.metadata && session.metadata.order_id) {
          await supabase.from('orders').update({
            status: 'payment_failed', updated_at: new Date().toISOString()
          }).eq('id', session.metadata.order_id);
          console.log('[Order] ' + (session.metadata.order_number || 'unknown') + ' checkout expired');
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn('[Stripe] Payment failed for customer:', invoice.customer);
        // Downgrade handled by customer.subscription.updated when status changes
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        console.log('[Stripe] Payment succeeded for customer:', invoice.customer);
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

module.exports = router;
