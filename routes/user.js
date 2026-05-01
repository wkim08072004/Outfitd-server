const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.user.userId = decoded.userId || decoded.id || decoded.sub || decoded.user_id;
    req.user.id = req.user.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid session' });
  }
}

async function requireAdmin(req, res, next) {
  const { data: user } = await supabase.from('users').select('role').eq('id', req.user.userId).single();
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// POST /api/orders/create
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { listing_id, shipping_address, stripe_payment_id } = req.body;

    const { data: listing } = await supabase
      .from('seller_listings').select('*').eq('id', listing_id).eq('status', 'published').single();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const { data: order, error } = await supabase.from('orders').insert({
      buyer_id: req.user.userId, seller_id: listing.seller_id, listing_id,
      total: listing.price, stripe_payment_id: stripe_payment_id || null,
      shipping_address: shipping_address || null, status: 'paid'
    }).select().single();

    if (error) throw error;
    res.status(201).json({ order });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ error: 'Order failed' });
  }
});

// GET /api/orders — buyer's orders
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders').select('*, seller_listings(title, images)')
      .eq('buyer_id', req.user.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ orders: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// POST /api/orders/:id/return
router.post('/:id/return', requireAuth, async (req, res) => {
  try {
    const { reason, resolution, notes, item_index, exchange_for } = req.body;
    const { data: order } = await supabase
      .from('orders').select('*').eq('id', req.params.id).eq('buyer_id', req.user.userId).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const orderDate = new Date(order.created_at);
    const now = new Date();
    if ((now - orderDate) > 30 * 24 * 60 * 60 * 1000)
      return res.status(400).json({ error: 'Return window has expired (30 days)' });

    const { data, error } = await supabase.from('order_returns').insert({
      order_id: req.params.id,
      buyer_id: req.user.userId,
      seller_id: order.seller_id || null,
      reason: reason || '',
      resolution: resolution || 'refund',
      notes: notes || '',
      item_index: Number.isFinite(parseInt(item_index)) ? parseInt(item_index) : 0,
      exchange_for: exchange_for || null,
      status: 'pending',
    }).select().single();

    if (error) throw error;

    await supabase.from('orders').update({ status: 'return_requested' }).eq('id', req.params.id);
    res.status(201).json({ return_request: data });
  } catch (err) {
    console.error('Return error:', err);
    res.status(500).json({ error: 'Return request failed' });
  }
});

// POST /api/orders/returns/:id/approve — admin
router.post('/returns/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    await supabase.from('order_returns')
      .update({ status: 'approved', approved_by: req.user.userId, approved_at: new Date().toISOString() })
      .eq('id', req.params.id);

    const { data: ret } = await supabase
      .from('order_returns').select('order_id').eq('id', req.params.id).single();

    await supabase.from('orders').update({ status: 'returned' }).eq('id', ret.order_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Approve failed' });
  }
});

module.exports = router;
