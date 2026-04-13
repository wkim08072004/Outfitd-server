// ============================================================
// sellerListings.js — Seller listings, profiles & applications
// Drop this file into your routes/ folder and register it in server.js
// ============================================================

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Supabase client (uses service role key for full access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Optional auth middleware — extracts user but doesn't block
function optionalAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    }
  } catch (e) { /* no auth, that's fine */ }
  next();
}

// ─────────────────────────────────────────────
// GET /api/seller/listings/all — PUBLIC, no auth
// Returns all active listings for the shop
// ─────────────────────────────────────────────
router.get('/listings/all', async (req, res) => {
  try {
    const { data: listings, error } = await supabase
      .from('seller_listings')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Also fetch seller profiles
    const { data: profiles } = await supabase
      .from('seller_profiles')
      .select('*');

    // Convert profiles array to { email: profile } map
    const sellers = {};
    (profiles || []).forEach(p => {
      if (p.email) sellers[p.email] = p;
    });

    // Map DB rows to frontend format
    const formatted = (listings || []).map(l => ({
      id: l.id,
      localId: l.local_id,
      name: l.name,
      brand: l.brand,
      category: l.category,
      price: Number(l.price),
      size: l.size || ['S', 'M', 'L'],
      color: l.color || 'Black',
      emoji: l.emoji || '👕',
      desc: l.description || '',
      style: l.style || 'Streetwear',
      photos: l.photos || [],
      sellerEmail: l.seller_email,
      condition: l.condition || 'New',
      returnWindow: l.return_window || '30 days',
      shipDays: l.ship_days || '3-7',
      stock: l.stock,
      photoPosition: l.photo_position || 'center center',
      photoFit: l.photo_fit || 'cover',
      badge: 'NEW',
      type: 'marketplace',
      listedAt: new Date(l.created_at).getTime()
    }));

    res.json({ listings: formatted, sellers });
  } catch (err) {
    console.error('GET /seller/listings/all error:', err.message);
    res.json({ listings: [], sellers: {} });
  }
});

// ─────────────────────────────────────────────
// GET /api/seller/listings — seller's own listings (auth optional)
// ─────────────────────────────────────────────
router.get('/listings', optionalAuth, async (req, res) => {
  try {
    let query = supabase
      .from('seller_listings')
      .select('*')
      .order('created_at', { ascending: false });

    // If authenticated, filter to this seller's listings
    if (req.user && req.user.email) {
      query = query.eq('seller_email', req.user.email);
    }

    const { data, error } = await query;
    if (error) throw error;

    const formatted = (data || []).map(l => ({
      id: l.id,
      localId: l.local_id,
      name: l.name,
      brand: l.brand,
      category: l.category,
      price: Number(l.price),
      size: l.size,
      color: l.color,
      emoji: l.emoji,
      desc: l.description,
      photos: l.photos || [],
      sellerEmail: l.seller_email,
      condition: l.condition,
      stock: l.stock,
      status: l.status
    }));

    res.json({ listings: formatted });
  } catch (err) {
    console.error('GET /seller/listings error:', err.message);
    res.json({ listings: [] });
  }
});

// ─────────────────────────────────────────────
// POST /api/seller/listings — create or update a listing
// ─────────────────────────────────────────────
router.post('/listings', optionalAuth, async (req, res) => {
  try {
    const b = req.body;

    // Check if listing already exists by localId
    let existing = null;
    if (b.localId) {
      const { data } = await supabase
        .from('seller_listings')
        .select('id')
        .or(`local_id.eq.${b.localId},local_id.eq.dyn_${b.localId}`)
        .limit(1);
      if (data && data.length) existing = data[0];
    }

    // Sanitize photos — skip huge base64 payloads (>500KB) to prevent DB bloat
    let photos = b.photos || [];
    photos = photos.filter(p => !p || p.length < 500000);

    const row = {
      local_id: String(b.localId || ''),
      name: b.name || '',
      brand: b.brand || '',
      category: b.category || '',
      price: Number(b.price) || 0,
      size: b.size || ['S', 'M', 'L'],
      color: b.color || 'Black',
      emoji: b.emoji || '👕',
      description: b.desc || b.description || '',
      style: b.style || 'Streetwear',
      photos: photos,
      seller_email: b.sellerEmail || (req.user && req.user.email) || '',
      condition: b.condition || 'New',
      return_window: b.returnWindow || '30',
      ship_days: b.shipDays || '3-7',
      stock: b.stock !== undefined ? b.stock : 1,
      photo_position: b.photoPosition || 'center center',
      photo_fit: b.photoFit || 'cover',
      status: 'active',
      updated_at: new Date().toISOString()
    };

    let result;
    if (existing) {
      // Update existing
      const { data, error } = await supabase
        .from('seller_listings')
        .update(row)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      // Insert new
      const { data, error } = await supabase
        .from('seller_listings')
        .insert(row)
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    res.json({ success: true, id: result.id, localId: result.local_id });
  } catch (err) {
    console.error('POST /seller/listings error:', err.message);
    res.status(500).json({ error: 'Failed to save listing' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/seller/listings/:id
// ─────────────────────────────────────────────
router.delete('/listings/:id', optionalAuth, async (req, res) => {
  try {
    const id = req.params.id;

    // Try deleting by id (numeric) or local_id (string)
    const numId = parseInt(id);
    if (!isNaN(numId)) {
      await supabase.from('seller_listings').delete().eq('id', numId);
    }
    // Also try by local_id variants
    await supabase.from('seller_listings').delete().eq('local_id', id);
    await supabase.from('seller_listings').delete().eq('local_id', 'dyn_' + id);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /seller/listings error:', err.message);
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

// ─────────────────────────────────────────────
// POST /api/seller/profile — sync seller profile
// ─────────────────────────────────────────────
router.post('/profile', optionalAuth, async (req, res) => {
  try {
    const { email, seller } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const row = {
      id: seller.id || 'seller_' + email.replace(/[^a-z0-9]/gi, '_'),
      email: email.toLowerCase().trim(),
      name: seller.name || '',
      handle: seller.handle || '',
      avatar: seller.avatar || '🏪',
      bio: seller.bio || '',
      location: seller.location || '',
      verified: true
    };

    const { error } = await supabase
      .from('seller_profiles')
      .upsert(row, { onConflict: 'email' });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('POST /seller/profile error:', err.message);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// ─────────────────────────────────────────────
// POST /api/seller/apply — submit seller application
// ─────────────────────────────────────────────
router.post('/apply', async (req, res) => {
  try {
    const b = req.body;
    const row = {
      type: b.type || 'seller',
      brand: b.brand || '',
      ig: b.ig || '',
      email: (b.email || '').toLowerCase().trim(),
      name: b.name || '',
      handle: b.handle || '',
      categories: b.categories || '',
      current_sales: b.currentSales || '',
      volume: b.volume || '',
      bio: b.bio || '',
      status: 'pending',
      agreement_version: b.agreementVersion || '',
      agreement_accepted_at: b.agreementAcceptedAt || null,
      agreement_user_agent: b.agreementUserAgent || ''
    };

    // Check for duplicate application
    const { data: existing } = await supabase
      .from('seller_applications')
      .select('id')
      .eq('email', row.email)
      .eq('status', 'pending')
      .limit(1);

    if (existing && existing.length) {
      return res.json({ success: true, message: 'Application already submitted' });
    }

    const { error } = await supabase
      .from('seller_applications')
      .insert(row);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('POST /seller/apply error:', err.message);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// ─────────────────────────────────────────────
// GET /api/seller/applications — admin: get all applications
// ─────────────────────────────────────────────
router.get('/applications', optionalAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seller_applications')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    const formatted = (data || []).map(a => ({
      type: a.type,
      brand: a.brand,
      ig: a.ig,
      email: a.email,
      name: a.name,
      handle: a.handle,
      categories: a.categories,
      currentSales: a.current_sales,
      volume: a.volume,
      bio: a.bio,
      status: a.status,
      agreementVersion: a.agreement_version,
      agreementAcceptedAt: a.agreement_accepted_at,
      submittedAt: a.submitted_at,
      inviteCode: a.invite_code
    }));

    res.json({ applications: formatted });
  } catch (err) {
    console.error('GET /seller/applications error:', err.message);
    res.json({ applications: [] });
  }
});

// ─────────────────────────────────────────────
// POST /api/seller/approve — admin: approve or reject app
// ─────────────────────────────────────────────
router.post('/approve', optionalAuth, async (req, res) => {
  try {
    const { email, status, code } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const updates = { status: status || 'approved' };
    if (code) updates.invite_code = code;

    const { error } = await supabase
      .from('seller_applications')
      .update(updates)
      .eq('email', email.toLowerCase().trim());

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('POST /seller/approve error:', err.message);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

// ─────────────────────────────────────────────
// POST /api/seller/partner-apply — partner application
// ─────────────────────────────────────────────
router.post('/partner-apply', async (req, res) => {
  try {
    const b = req.body;
    const row = {
      type: 'partner',
      brand: b.brand || '',
      ig: b.url || '',
      email: (b.email || '').toLowerCase().trim(),
      name: b.name || '',
      bio: b.message || '',
      status: 'pending'
    };

    const { error } = await supabase
      .from('seller_applications')
      .insert(row);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('POST /seller/partner-apply error:', err.message);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

module.exports = router;
