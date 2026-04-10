// ═══════════════════════════════════════════════════════════════
// seller.js — Seller application & listing routes
// Drop into /Users/eshapatel/outfitd-server/routes/seller.js
// Add to server.js: app.use('/api/seller', require('./routes/seller'));
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
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

function requireSeller(req, res, next) {
  if (!req.user || req.user.role !== 'seller' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Seller access required' });
  }
  next();
}
// GET /api/seller/listings — Fetch seller's own listings
router.get('/listings', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('listings').select('*').eq('seller_id', req.user.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ listings: data || [] });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch listings' }); }
});

// GET /api/seller/listings/all — All active listings (public)
router.get('/listings/all', async (req, res) => {
  try {
    const { data, error } = await supabase.from('listings').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const result = (data || []).map(l => ({
      id: l.id, name: l.name, brand: l.brand || l.seller_name || 'Seller', sellerName: l.seller_name, sellerEmail: l.seller_email, sellerId: l.seller_id, category: l.category, price: parseFloat(l.price), size: l.size || ['S','M','L'], color: l.color, emoji: l.emoji || '👕', desc: l.description, style: l.style, condition: l.condition, returnWindow: l.return_window, shipDays: l.ship_days, photos: l.photos || [], photo: (l.photos && l.photos[0]) || null, stock: l.stock, sold: l.sold, createdAt: new Date(l.created_at).getTime()
    }));
    res.json({ listings: result });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch listings' }); }
});

// POST /api/seller/listings — Create listing
router.post('/listings', requireAuth, async (req, res) => {
  try {
    const { name, brand, category, price, size, color, emoji, desc, style, condition, returnWindow, shipDays, photos, stock } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if (!price || price <= 0) return res.status(400).json({ error: 'Valid price required' });
    const { data: user } = await supabase.from('users').select('handle, email').eq('id', req.user.id).single();
    const { data, error } = await supabase.from('listings').insert({
      seller_id: req.user.id, seller_email: user?.email || '', seller_name: brand || user?.handle || 'Seller', name: name.trim().slice(0, 100), brand: brand || user?.handle || 'Seller', category: category || 'Tops', price: parseFloat(price), size: Array.isArray(size) ? size : (size ? String(size).split(',').map(s => s.trim()).filter(Boolean) : ['S','M','L']), color: color || 'Black', emoji: emoji || '👕', description: (desc || '').slice(0, 500), style: style || 'Streetwear', condition: condition || 'New', return_window: returnWindow || '30 days', ship_days: shipDays || '3-7', photos: photos || [], stock: parseInt(stock) || 1
    }).select().single();
    if (error) throw error;
    res.json({ listing: data });
  } catch (err) { res.status(500).json({ error: 'Failed to create listing' }); }
});

// DELETE /api/seller/listings/:id
router.delete('/listings/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('listings').select('seller_id').eq('id', req.params.id).single();
    if (!existing || existing.seller_id !== req.user.id) return res.status(403).json({ error: 'Not your listing' });
    const { error } = await supabase.from('listings').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete listing' }); }
});
// ═══════════════════════════════════════════════════════════════
// POST /api/seller/apply — Submit seller application
// ═══════════════════════════════════════════════════════════════
router.post('/apply', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { brand, ig, email, categories, currentSales, volume, bio,
            agreementVersion, agreementAcceptedAt, agreementUserAgent } = req.body;

    if (!brand || !email) {
      return res.status(400).json({ error: 'Brand name and email required' });
    }

    const { data, error } = await supabase
      .from('seller_applications')
      .insert({
        user_id: userId,
        brand_name: brand,
        brand_type: 'marketplace',
        website: null,
        instagram: ig || null,
        description: bio || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ application_id: data.id, status: 'pending' });
  } catch (err) {
    console.error('Seller apply error:', err);
    return res.status(500).json({ error: 'Application submission failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/seller/partner-apply — Submit partner/affiliate application
// ═══════════════════════════════════════════════════════════════
router.post('/partner-apply', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { brand, url, email, commission } = req.body;

    if (!brand || !email) {
      return res.status(400).json({ error: 'Brand name and email required' });
    }

    const { data, error } = await supabase
      .from('seller_applications')
      .insert({
        user_id: userId,
        brand_name: brand,
        brand_type: 'partner',
        website: url || null,
        description: `Commission: ${commission || 'standard'}`,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ application_id: data.id, status: 'pending' });
  } catch (err) {
    console.error('Partner apply error:', err);
    return res.status(500).json({ error: 'Application submission failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/seller/listings — Create a product listing (seller only)
// ═══════════════════════════════════════════════════════════════
router.post('/listings', requireAuth, requireSeller, async (req, res) => {
  try {
    const { name, description, price, category, sizes, colors, style_tags, is_final_sale, inventory } = req.body;

    if (!name || !price || price <= 0) {
      return res.status(400).json({ error: 'Name and valid price required' });
    }

    const { data, error } = await supabase
      .from('products')
      .insert({
        seller_id: req.user.id,
        name,
        description: description || '',
        price: Math.round(price * 100) / 100,
        category: category || 'general',
        sizes: sizes || [],
        colors: colors || [],
        style_tags: style_tags || [],
        listing_status: 'pending', // Requires admin approval
        is_final_sale: is_final_sale || false,
        inventory: inventory || 0,
      })
      .select()
      .single();

    if (error) throw error;
    return res.json({ product: data });
  } catch (err) {
    console.error('Listing create error:', err);
    return res.status(500).json({ error: 'Failed to create listing' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/seller/listings — Get seller's own listings
// ═══════════════════════════════════════════════════════════════
router.get('/listings', requireAuth, requireSeller, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('seller_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ listings: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

module.exports = router;
