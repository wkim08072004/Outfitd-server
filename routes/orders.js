// ═══════════════════════════════════════════════════════════════
// orders.js — Marketplace order routes
// Drop into /Users/eshapatel/outfitd-server/routes/orders.js
// Add to server.js: app.use('/api/orders', require('./routes/orders'));
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Marketplace economics (mirror of the frontend constants) ──────────────
// Of the item subtotal: 85% → seller, 10% → Outfitd, 5% → buyer Style Points.
// Shipping is flat and goes to the seller to cover postage. Tax is collected
// and remitted by Outfitd.
const SHIPPING_FLAT_FEE  = 4;
const SELLER_PAYOUT_PCT  = 0.85;
const PLATFORM_FEE_PCT   = 0.10;
const BUYER_REWARD_PCT   = 0.05;

// ── Auth middleware (reuse your existing one, or inline) ──
function requireAuth(req, res, next) {
  // Assumes your auth middleware attaches req.user with { id, email, role }
  // If you have a different pattern, swap this out
  const jwt = require('jsonwebtoken');
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
// GET /api/orders — Fetch user's order history
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('buyer_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    // Order history is non-critical UI; never 500 the request. Log the cause
    // server-side and return an empty list so the frontend shows its
    // "no orders yet" state instead of a broken modal.
    if (error) {
      console.warn('GET /api/orders — query failed, returning []:',
        error.code || '(no code)', error.message || '(no message)');
      return res.json({ orders: [] });
    }

    const { data: user } = await supabase
      .from('users').select('handle').eq('id', userId).single();
    const buyerHandle = user?.handle ? ('@' + user.handle.replace('@','')) : '';

    const result = (orders || []).map(o => {
      const addr = o.shipping_address || {};
      const addrStr = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
      return {
        id: o.id,
        buyer: buyerHandle,
        createdAt: new Date(o.created_at).getTime(),
        status: o.status || 'awaiting_fulfillment',
        items: [{ emoji: '📦', name: 'Order Item', brand: '', size: '', price: (o.total || 0) / 100 }],
        paymentMethod: o.stripe_payment_id ? 'stripe' : 'stripe',
        subtotal: (o.total || 0) / 100,
        shipping: 0,
        tax: 0,
        total: (o.total || 0) / 100,
        shippingAddress: addrStr,
        trackingNumber: o.tracking_number || null
      };
    });
    res.json({ orders: result });
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});
// ═══════════════════════════════════════════════════════════════
// POST /api/orders/create
// Creates order in DB + Stripe Checkout Session, returns checkout URL
// ═══════════════════════════════════════════════════════════════
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { items, shipping_address, email, payment_method, store_credit_applied } = req.body;
    const userId = req.user.userId;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items provided' });
    }
    if (!shipping_address || !shipping_address.street) {
      return res.status(400).json({ error: 'Shipping address required' });
    }

    // ── Calculate totals SERVER-SIDE (never trust client totals) ──
    // In production: look up each product price from the DB
    // For now, validate items have prices and compute server-side
    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      // TODO: Look up actual price from products table
      // const { data: product } = await supabase.from('products').select('price').eq('id', item.product_id).single();
      // const serverPrice = product.price;
      const serverPrice = Math.round(item.price * 100) / 100; // cents safety
      if (serverPrice <= 0 || serverPrice > 50000) {
        return res.status(400).json({ error: 'Invalid item price: ' + item.name });
      }
      subtotal += serverPrice * (item.qty || 1);
      validatedItems.push({
        product_id: item.product_id,
        brand: item.brand,
        seller_id: item.seller_id,
        name: item.name,
        size: item.size,
        qty: item.qty || 1,
        unit_price: serverPrice,
      });
    }

    const shipping = SHIPPING_FLAT_FEE;
    const tax = Math.round(subtotal * 0.08 * 100) / 100;
    const total = Math.round((subtotal + shipping + tax) * 100) / 100;
    const platformFee = Math.round(subtotal * PLATFORM_FEE_PCT * 100) / 100;

    // ── Create order in DB ──
    const orderNumber = 'OFD-MKT-' + Date.now().toString(36).toUpperCase().slice(-8);

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        order_number: orderNumber,
        user_id: userId,
        buyer_email: email,
        shipping_address: shipping_address,
        items: validatedItems,
        subtotal,
        shipping,
        tax,
        total,
        platform_fee: platformFee,
        // Seller keeps 85% of the item subtotal + the full flat shipping fee
        // (postage cost is theirs to absorb against the $4 we charged).
        seller_payout: Math.round((subtotal * SELLER_PAYOUT_PCT + shipping) * 100) / 100,
        status: 'pending_payment',
        payment_method: payment_method || 'stripe',
        store_credit_applied: store_credit_applied || 0,
      })
      .select()
      .single();

    if (orderErr) {
      console.error('Order creation error:', orderErr);
      return res.status(500).json({ error: 'Failed to create order' });
    }

    // ── Create Stripe Checkout Session ──
    // Get or create Stripe customer
    let stripeCustomerId;
    const { data: userRecord } = await supabase
      .from('users')
      .select('stripe_customer_id, email')
      .eq('id', userId)
      .single();

    if (userRecord?.stripe_customer_id) {
      stripeCustomerId = userRecord.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: email || userRecord?.email,
        metadata: { outfitd_user_id: userId },
      });
      stripeCustomerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customer.id }).eq('id', userId);
    }

    const lineItems = validatedItems.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: `${item.brand} · Size ${item.size}`,
        },
        unit_amount: Math.round(item.unit_price * 100), // Stripe uses cents
      },
      quantity: item.qty,
    }));

    // Add shipping as a line item if applicable
    if (shipping > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Shipping' },
          unit_amount: Math.round(shipping * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'payment',
      line_items: lineItems,
      automatic_tax: { enabled: false }, // We calculate tax ourselves
      metadata: {
        order_id: order.id,
        order_number: orderNumber,
        platform_fee: platformFee.toString(),
      },
      success_url: `${process.env.FRONTEND_URL}?order_success=${orderNumber}`,
      cancel_url: `${process.env.FRONTEND_URL}?order_cancelled=${orderNumber}`,
    });

    // Update order with Stripe session ID
    await supabase
      .from('orders')
      .update({ stripe_session_id: session.id })
      .eq('id', order.id);

    return res.json({ checkout_url: session.url, order_number: orderNumber });
  } catch (err) {
    console.error('Order create error:', err);
    return res.status(500).json({ error: 'Order processing failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/confirm-payment
// Called by the frontend after Stripe.js confirms a PaymentIntent.
// Verifies the PaymentIntent succeeded with Stripe, then writes one
// order row per cart item. Idempotent: re-calling with the same
// payment_intent_id returns the previously-inserted order IDs without
// double-charging anyone (the source of truth is the (buyer, listing,
// stripe_payment_id) tuple).
// ═══════════════════════════════════════════════════════════════
router.post('/confirm-payment', requireAuth, async (req, res) => {
  const { payment_intent_id, items, shipping_address, email } = req.body || {};
  const buyerId = req.user.userId;
  if (!payment_intent_id) {
    return res.status(400).json({ error: 'payment_intent_id required' });
  }

  try {
    // 1) Verify with Stripe — never trust the client to say "I paid"
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.status !== 'succeeded') {
      console.warn('[confirm-payment] PaymentIntent not succeeded:',
        payment_intent_id, intent.status);
      return res.status(400).json({
        error: 'Payment not completed',
        intent_status: intent.status,
      });
    }

    // 2) Idempotency: if we've already recorded any rows for this
    //    payment_intent_id, return them unchanged.
    const { data: existing } = await supabase
      .from('orders')
      .select('id, listing_id, seller_id')
      .eq('stripe_payment_id', payment_intent_id);
    if (existing && existing.length > 0) {
      return res.json({
        ok: true,
        already_recorded: true,
        order_ids: existing.map(o => o.id),
      });
    }

    // 3) Decide what to insert. If the frontend forwarded the cart
    //    (the normal happy path), one order row per item — and we attribute
    //    the seller's per-seller shipping fee to the FIRST item from that
    //    seller (sellers ship as one package per buyer, so shipping is paid
    //    once per seller, not per item). If items aren't provided (e.g. on
    //    a 3DS redirect-return where the form is gone), fall back to a
    //    single row keyed off the PaymentIntent total.
    const rows = [];
    if (Array.isArray(items) && items.length > 0) {
      // Compute per-seller shipping (MAX of items' shipping_price) and
      // attribute it once per seller — same rule as the frontend cart.
      const sellerShipping = {};
      const sellerShippingClaimed = {};
      for (const item of items) {
        const sid = item.seller_id || item.sellerId || '__unknown__';
        const ship = Number(item.shipping_price);
        const v = Number.isFinite(ship) ? Math.max(0, ship) : 4;
        if (sellerShipping[sid] === undefined || v > sellerShipping[sid]) sellerShipping[sid] = v;
      }
      for (const item of items) {
        const unitPrice = Number(item.price) || 0;
        const qty = Number(item.qty) || 1;
        const sid = item.seller_id || item.sellerId || '__unknown__';
        // First row for this seller pays the seller's shipping fee
        const shippingForRow = sellerShippingClaimed[sid] ? 0 : (sellerShipping[sid] || 0);
        sellerShippingClaimed[sid] = true;
        const itemTotalCents = Math.round((unitPrice * qty + shippingForRow) * 100);
        rows.push({
          buyer_id: buyerId,
          seller_id: item.seller_id || item.sellerId || null,
          listing_id: item.product_id || item.id || null,
          total: itemTotalCents,
          stripe_payment_id: payment_intent_id,
          shipping_address: shipping_address || null,
          status: 'paid',
        });
      }
    } else {
      rows.push({
        buyer_id: buyerId,
        seller_id: null,
        listing_id: null,
        total: intent.amount, // already in cents
        stripe_payment_id: payment_intent_id,
        shipping_address: shipping_address || null,
        status: 'paid',
      });
    }

    const orderIds = [];
    const insertErrors = [];
    for (const row of rows) {
      const { data, error } = await supabase
        .from('orders').insert(row).select('id').single();
      if (error) {
        insertErrors.push(error.message || String(error));
        console.error('[confirm-payment] insert failed:',
          error.code || '(no code)', error.message || '(no message)',
          'row:', JSON.stringify(row));
        continue;
      }
      if (data && data.id) orderIds.push(data.id);
    }

    if (orderIds.length === 0) {
      // Fail loud — Stripe charged but we didn't record anything.
      // The frontend should surface this to the user with support contact info.
      return res.status(500).json({
        error: 'Payment succeeded but order could not be recorded. Please contact support with this reference.',
        payment_intent_id,
        details: insertErrors.join('; '),
      });
    }

    // Optional buyer-side email update for downstream display
    if (email) {
      await supabase
        .from('orders')
        .update({ buyer_email: email })
        .eq('stripe_payment_id', payment_intent_id);
    }

    // ── Award the buyer their 5% Style Points reward ─────────────────────
    // Compute against the item subtotal only (not shipping or tax). Insider
    // and Legend tiers earn at higher rates, matching the existing webhook
    // path's tierRate logic so the two flows can never disagree.
    let pointsAwarded = 0;
    try {
      const subtotalCents = (Array.isArray(items) && items.length)
        ? items.reduce((acc, it) => acc + Math.round((Number(it.price) || 0) * (Number(it.qty) || 1) * 100), 0)
        : intent.amount; // fall back to the full charge if cart wasn't forwarded

      const { data: buyer } = await supabase
        .from('users')
        .select('subscription, op_balance')
        .eq('id', buyerId)
        .single();
      const tierRate = (buyer && buyer.subscription === 'legend') ? 0.10
        : (buyer && buyer.subscription === 'insider') ? 0.07 : BUYER_REWARD_PCT;
      // Style Points are integer points where 100 pts = $1. So 5% of a $15
      // subtotal ($0.75) becomes 75 pts. Express as: cents * rate.
      pointsAwarded = Math.round(subtotalCents * tierRate);
      if (pointsAwarded > 0 && buyer) {
        await supabase
          .from('users')
          .update({ op_balance: (buyer.op_balance || 0) + pointsAwarded })
          .eq('id', buyerId);
        await supabase.from('transactions').insert({
          user_id: buyerId,
          type: 'purchase_reward',
          currency: 'op_balance',
          amount: pointsAwarded,
          description: 'Order reward: +' + pointsAwarded + ' Style Points',
        });
      }
    } catch (pointsErr) {
      // Style Points award is best-effort; do not fail the order on this.
      console.warn('[confirm-payment] Style Points award skipped:',
        pointsErr.message || pointsErr);
    }

    res.json({
      ok: true,
      order_ids: orderIds,
      payment_intent_id,
      style_points_awarded: pointsAwarded,
    });
  } catch (err) {
    console.error('[confirm-payment] error:', err);
    res.status(500).json({
      error: err.message || 'Failed to confirm payment',
      payment_intent_id,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/seller
// Returns orders where the current user is the seller. Powers the
// seller dashboard's orders tab (which previously tried to filter the
// buyer's order list — which never contains the seller's own sales).
// ═══════════════════════════════════════════════════════════════
router.get('/seller', requireAuth, async (req, res) => {
  try {
    const sellerId = req.user.userId;
    // Try the joined query first for richer line-item data; if the FK
    // isn't configured between orders.listing_id and seller_listings.id,
    // fall back to a plain select so the dashboard still renders.
    let data, error;
    ({ data, error } = await supabase
      .from('orders')
      .select('*, seller_listings(title, images)')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .limit(200));
    if (error) {
      console.warn('[orders/seller] join query failed, retrying without join:',
        error.code || '(no code)', error.message || '(no message)');
      ({ data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('seller_id', sellerId)
        .order('created_at', { ascending: false })
        .limit(200));
    }
    if (error) {
      console.warn('[orders/seller] fallback select failed, returning []:',
        error.code || '(no code)', error.message || '(no message)');
      return res.json({ orders: [] });
    }
    // Reshape into the shape the seller dashboard render template expects.
    // The frontend filters `o.items` by `i.brand === sellerName`, so we set
    // brand = the seller's own display name to make the existing filter pass.
    const { data: seller } = await supabase
      .from('users').select('name, handle').eq('id', sellerId).single();
    const sellerName = (seller && (seller.name || seller.handle)) || 'Seller';

    const shaped = (data || []).map(o => {
      const listing = o.seller_listings || {};
      const addr = o.shipping_address || {};
      const addrStr = typeof o.shipping_address === 'string'
        ? o.shipping_address
        : [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
      return {
        id: o.id,
        items: [{ brand: sellerName, name: listing.title || 'Item', size: '' }],
        shippingAddress: addrStr,
        total: (o.total || 0) / 100, // dollars (frontend expects dollars)
        status: o.status || 'paid',
        createdAt: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
      };
    });
    res.json({ orders: shaped });
  } catch (err) {
    console.error('GET /api/orders/seller error:', err);
    res.status(500).json({ error: 'Failed to fetch seller orders' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/history
// Returns the user's past orders
// ═══════════════════════════════════════════════════════════════
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: 'Failed to fetch orders' });
    return res.json({ orders: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/:id
// Returns a single order detail
// ═══════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('order_number', req.params.id)
      .eq('user_id', req.user.userId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Order not found' });
    return res.json({ order: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

module.exports = router;
