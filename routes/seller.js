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
