// ═══════════════════════════════════════════════════════════════
// trade.js — Trade-closet routes (location-based in-person trading)
// Mounted as: app.use('/api/trade', require('./routes/trade'));
//
// Privacy invariant: we NEVER store raw GPS coordinates. Every
// location write resolves to the containing zip first, then stores
// the zip centroid. Discover never returns exact coordinates — only
// city/state and rounded distance.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { lookupZip, nearestZip } = require('../lib/us_zips');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Auth (copied from routes/seller.js — re-reads role each request) ─────
async function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  try {
    const userId = decoded.id || decoded.userId || decoded.sub || decoded.user_id;
    if (userId) {
      const { data: dbUser, error: dbErr } = await supabase
        .from('users')
        .select('id, email, handle, display_name, role, zip, lat, lng, trade_radius_miles')
        .eq('id', userId)
        .single();
      if (!dbErr && dbUser) {
        req.user = Object.assign({}, decoded, dbUser);
        return next();
      }
    }
    req.user = decoded;
    next();
  } catch (e) {
    req.user = decoded;
    next();
  }
}

function userId(req) {
  return (
    req.user?.id ||
    req.user?.userId ||
    req.user?.sub ||
    req.user?.user_id ||
    null
  );
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/trade/location
//   Body: { zip } OR { lat, lng }
//   Coarsens to the zip centroid and writes users.{zip,lat,lng,country}.
//   Returns the stored zip + centroid (NOT the raw input).
// ──────────────────────────────────────────────────────────────────────
router.post('/location', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const { zip, lat, lng } = req.body || {};
  let resolved = null;

  if (zip) {
    resolved = lookupZip(String(zip));
    if (!resolved) {
      return res.status(400).json({
        error: 'Unknown US zip. Non-US locations are outside MVP scope.',
      });
    }
  } else if (typeof lat === 'number' && typeof lng === 'number') {
    const near = nearestZip(lat, lng);
    if (!near) {
      return res.status(400).json({
        error: 'Could not resolve coordinates to a US zip.',
      });
    }
    resolved = { zip: near.zip, lat: near.lat, lng: near.lng };
  } else {
    return res
      .status(400)
      .json({ error: 'Provide either { zip } or { lat, lng }.' });
  }

  const { error } = await supabase
    .from('users')
    .update({
      zip: resolved.zip,
      lat: resolved.lat,
      lng: resolved.lng,
      country: 'US',
      updated_at: new Date().toISOString(),
    })
    .eq('id', uid);

  if (error) {
    return res.status(500).json({ error: 'Could not save location.' });
  }
  return res.json({
    zip: resolved.zip,
    lat: resolved.lat,
    lng: resolved.lng,
  });
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/trade/radius   Body: { miles }
// ──────────────────────────────────────────────────────────────────────
router.patch('/radius', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  let m = parseInt(req.body?.miles, 10);
  if (!Number.isFinite(m)) {
    return res.status(400).json({ error: 'miles must be an integer' });
  }
  if (m < 1) m = 1;
  if (m > 500) m = 500;

  const { error } = await supabase
    .from('users')
    .update({ trade_radius_miles: m, updated_at: new Date().toISOString() })
    .eq('id', uid);
  if (error) return res.status(500).json({ error: 'Could not save radius.' });
  return res.json({ trade_radius_miles: m });
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/trade/closet/me
// ──────────────────────────────────────────────────────────────────────
router.get('/closet/me', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const { data, error } = await supabase
    .from('closet_items')
    .select('*')
    .eq('owner_id', uid)
    .neq('status', 'removed')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Could not load closet.' });
  return res.json({ items: data || [] });
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/trade/closet/:userId
//   Public-to-other-users view of someone's closet (available only).
// ──────────────────────────────────────────────────────────────────────
router.get('/closet/:userId', requireAuth, async (req, res) => {
  const targetId = req.params.userId;
  if (!targetId) return res.status(400).json({ error: 'userId required' });

  const [{ data: items, error: itemsErr }, { data: owner, error: ownerErr }] =
    await Promise.all([
      supabase
        .from('closet_items')
        .select('*')
        .eq('owner_id', targetId)
        .eq('status', 'available')
        .order('created_at', { ascending: false }),
      supabase
        .from('users')
        .select('id, handle, display_name, avatar_url, city, state')
        .eq('id', targetId)
        .single(),
    ]);

  if (itemsErr || ownerErr) {
    return res.status(500).json({ error: 'Could not load closet.' });
  }
  return res.json({ owner, items: items || [] });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/trade/closet — create a closet item
//   Body: { title, brand?, category?, size?, condition?, color?,
//           description?, photos: string[] }
// ──────────────────────────────────────────────────────────────────────
router.post('/closet', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const b = req.body || {};
  if (!b.title || typeof b.title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }
  const photos = Array.isArray(b.photos)
    ? b.photos.filter((p) => typeof p === 'string').slice(0, 8)
    : [];

  const row = {
    owner_id: uid,
    title: String(b.title).slice(0, 120),
    brand: b.brand ? String(b.brand).slice(0, 80) : null,
    category: b.category ? String(b.category).slice(0, 40) : null,
    size: b.size ? String(b.size).slice(0, 40) : null,
    condition: b.condition ? String(b.condition).slice(0, 40) : null,
    color: b.color ? String(b.color).slice(0, 40) : null,
    description: b.description ? String(b.description).slice(0, 2000) : null,
    photos,
    status: 'available',
  };

  const { data, error } = await supabase
    .from('closet_items')
    .insert(row)
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Could not create item.' });
  return res.status(201).json({ item: data });
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/trade/closet/:id — owner-only
// ──────────────────────────────────────────────────────────────────────
router.patch('/closet/:id', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params.id;
  const { data: existing, error: getErr } = await supabase
    .from('closet_items')
    .select('owner_id')
    .eq('id', id)
    .single();
  if (getErr || !existing) return res.status(404).json({ error: 'Not found' });
  if (existing.owner_id !== uid)
    return res.status(403).json({ error: 'Not your item' });

  const b = req.body || {};
  const updates = {};
  const allowed = [
    'title', 'brand', 'category', 'size', 'condition',
    'color', 'description', 'photos', 'status',
  ];
  for (const k of allowed) {
    if (k in b) {
      if (k === 'photos') {
        updates.photos = Array.isArray(b.photos)
          ? b.photos.filter((p) => typeof p === 'string').slice(0, 8)
          : [];
      } else if (k === 'status') {
        if (!['available', 'pending', 'traded', 'removed'].includes(b.status)) {
          return res.status(400).json({ error: 'Invalid status' });
        }
        updates.status = b.status;
      } else {
        updates[k] = b[k] == null ? null : String(b[k]).slice(0, 2000);
      }
    }
  }

  const { data, error } = await supabase
    .from('closet_items')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Could not update item.' });
  return res.json({ item: data });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/trade/closet/:id — soft-delete (status='removed')
// ──────────────────────────────────────────────────────────────────────
router.delete('/closet/:id', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params.id;
  const { data: existing, error: getErr } = await supabase
    .from('closet_items')
    .select('owner_id')
    .eq('id', id)
    .single();
  if (getErr || !existing) return res.status(404).json({ error: 'Not found' });
  if (existing.owner_id !== uid)
    return res.status(403).json({ error: 'Not your item' });

  const { error } = await supabase
    .from('closet_items')
    .update({ status: 'removed' })
    .eq('id', id);
  if (error) return res.status(500).json({ error: 'Could not delete item.' });
  return res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/trade/discover?radius=N&category=&q=&limit=
//   Returns items from other users within radius miles, sorted by
//   distance. If the searcher has no location, returns 409 so the
//   frontend can prompt them to set one.
// ──────────────────────────────────────────────────────────────────────
router.get('/discover', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  if (!req.user?.lat || !req.user?.lng) {
    return res.status(409).json({
      error: 'no_location',
      message: 'Set your zip or use your location first.',
    });
  }

  let radius = parseFloat(req.query.radius);
  if (!Number.isFinite(radius)) {
    radius = req.user.trade_radius_miles || 25;
  }
  radius = Math.max(1, Math.min(500, radius));

  let lim = parseInt(req.query.limit, 10);
  if (!Number.isFinite(lim)) lim = 60;
  lim = Math.max(1, Math.min(200, lim));

  const category = req.query.category ? String(req.query.category) : null;
  const q = req.query.q ? String(req.query.q).slice(0, 80) : null;

  const { data, error } = await supabase.rpc('discover_closet_items', {
    searcher_id: uid,
    radius_miles: radius,
    category_filter: category,
    search_q: q,
    lim,
  });

  if (error) {
    return res.status(500).json({ error: 'Discover query failed.' });
  }
  return res.json({
    radius_miles: radius,
    count: (data || []).length,
    items: data || [],
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/trade/contact/:itemId — STUB (no messaging system yet)
//   Returns 501 by design. Frontend renders a "coming soon" modal.
//   Phase 2 will replace this with a real DM endpoint.
// ──────────────────────────────────────────────────────────────────────
router.post('/contact/:itemId', requireAuth, (req, res) => {
  return res.status(501).json({
    error: 'not_implemented',
    message:
      'In-app messaging is coming soon. For MVP, trades are arranged ' +
      'in person — exchange contact details safely off-platform.',
  });
});

module.exports = router;
