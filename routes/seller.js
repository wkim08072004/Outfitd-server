const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
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

async function requireSeller(req, res, next) {
  const { data: user } = await supabase.from('users').select('role').eq('id', req.user.userId).single();
  if (!user || (user.role !== 'seller' && user.role !== 'admin'))
    return res.status(403).json({ error: 'Seller access required' });
  next();
}

// POST /api/seller/apply
router.post('/apply', requireAuth, async (req, res) => {
  try {
    const { brand_name, website, description } = req.body;
    if (!brand_name) return res.status(400).json({ error: 'Brand name required' });

    const { data, error } = await supabase.from('seller_applications').insert({
      user_id: req.user.userId, brand_name, website: website || null, description: description || ''
    }).select().single();

    if (error) throw error;
    res.status(201).json({ application: data });
  } catch (err) {
    console.error('Apply error:', err);
    res.status(500).json({ error: 'Application failed' });
  }
});

// POST /api/seller/:id/approve — admin only
router.post('/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: app } = await supabase
      .from('seller_applications').select('*').eq('id', req.params.id).single();
    if (!app) return res.status(404).json({ error: 'Application not found' });

    await supabase.from('seller_applications')
      .update({ status: 'approved', reviewed_by: req.user.userId, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id);

    await supabase.from('users').update({ role: 'seller' }).eq('id', app.user_id);

    res.json({ success: true });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: 'Approve failed' });
  }
});

// POST /api/seller/listings/create
router.post('/listings/create', requireAuth, requireSeller, async (req, res) => {
  try {
    const { title, description, price, images, category, sizes } = req.body;
    if (!title || !price) return res.status(400).json({ error: 'Title and price required' });

    const { data, error } = await supabase.from('seller_listings').insert({
      seller_id: req.user.userId, title, description: description || '',
      price, images: images || [], category: category || null, sizes: sizes || [], status: 'draft'
    }).select().single();

    if (error) throw error;
    res.status(201).json({ listing: data });
  } catch (err) {
    console.error('Create listing error:', err);
    res.status(500).json({ error: 'Create failed' });
  }
});

// GET /api/seller/listings — seller's own listings
router.get('/listings', requireAuth, requireSeller, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seller_listings').select('*').eq('seller_id', req.user.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ listings: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// PUT /api/seller/listings/:id
router.put('/listings/:id', requireAuth, requireSeller, async (req, res) => {
  try {
    const { title, description, price, images, category, sizes, status } = req.body;
    const { data, error } = await supabase.from('seller_listings')
      .update({ title, description, price, images, category, sizes, status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('seller_id', req.user.userId)
      .select().single();
    if (error) throw error;
    res.json({ listing: data });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/seller/listings/:id
router.delete('/listings/:id', requireAuth, requireSeller, async (req, res) => {
  try {
    await supabase.from('seller_listings')
      .delete().eq('id', req.params.id).eq('seller_id', req.user.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// GET /api/seller/listings/public — all published listings (no auth needed)
router.get('/listings/public', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seller_listings').select('*').eq('status', 'published')
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ listings: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

module.exports = router;
