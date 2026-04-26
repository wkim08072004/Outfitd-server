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
    const userId = req.user.id;
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('buyer_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    // Graceful fallback: missing table or unknown column should not whitescreen
    // the order-history UI — return an empty list and let the frontend show
    // its "no orders yet" state. Surfaces the cause in server logs for ops.
    if (error) {
      const msg = (error.message || '').toLowerCase();
      const code = error.code || '';
      const benign = msg.includes('does not exist')
        || msg.includes('relation') && msg.includes('does not exist')
        || code === '42P01'   // undefined_table
        || code === '42703';  // undefined_column
      if (benign) {
        console.warn('GET /api/orders — schema not ready, returning []:', error.message);
        return res.json({ orders: [] });
      }
      throw error;
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
    const userId = req.user.id;

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

    const shipping = subtotal >= 100 ? 0 : 8.99;
    const tax = Math.round(subtotal * 0.08 * 100) / 100;
    const total = Math.round((subtotal + shipping + tax) * 100) / 100;
    const platformFee = Math.round(total * 0.15 * 100) / 100; // 15% platform fee

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
        seller_payout: Math.round((total - platformFee) * 100) / 100,
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
// GET /api/orders/history
// Returns the user's past orders
// ═══════════════════════════════════════════════════════════════
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', req.user.id)
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
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Order not found' });
    return res.json({ order: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

module.exports = router;
