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

// ── Helpers ──────────────────────────────────────────────────────────────
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
  if (!req.user || (req.user.role !== 'seller' && req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Seller access required' });
  }
  next();
}

// Identify admin by role OR by a known hardcoded handle (@wyk). If your
// JWT payload uses a different field name for the handle, add it here.
function isAdminUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const h = String(user.handle || user.username || '').toLowerCase().replace(/^@/, '');
  if (h === 'wyk') return true;
  return false;
}

// Normalize the wire-format from the frontend POST into a seller_listings row.
// The frontend lives in a single HTML file and uses its own shape; we map it
// to the DB columns explicitly so there are no silently-dropped fields.
function buildListingRow(body, user) {
  const sellerEmail = (body.sellerEmail || user.email || '').toLowerCase();
  const photos = Array.isArray(body.photos) ? body.photos : (body.photos ? [body.photos] : []);
  const sizeArr = Array.isArray(body.size)
    ? body.size
    : (body.size ? String(body.size).split(',').map(s => s.trim()).filter(Boolean) : []);

  // The shop reader in index.html tries JSON.parse(description) to recover
  // metadata that doesn't have its own column. We preserve that contract.
  const descriptionJson = JSON.stringify({
    desc: body.desc || '',
    condition: body.condition || 'New',
    returnWindow: body.returnWindow || '30',
    shipDays: body.shipDays || '3-7',
    stock: body.stock !== undefined ? body.stock : -1,
    photoPosition: body.photoPosition || 'center center',
    photoFit: body.photoFit || 'cover',
    localId: body.localId || null,
    style: body.style || 'Streetwear',
  });

  return {
    seller_id: user.id,
    seller_email: sellerEmail,
    local_id: body.localId || null,
    title: body.name || '',
    name: body.name || '',
    brand: body.brand || '',
    category: body.category || 'Tops',
    price: Number(body.price) || 0,
    color: body.color || 'Black',
    emoji: body.emoji || '👗',
    style: body.style || 'Streetwear',
    size: sizeArr,
    sizes: sizeArr,
    photos,
    images: photos,
    condition: body.condition || 'New',
    return_window: String(body.returnWindow || '30'),
    ship_days: String(body.shipDays || '3-7'),
    stock: body.stock !== undefined ? Number(body.stock) : -1,
    description: descriptionJson,
    status: 'active',
  };
}

// Frontend compatibility: add camelCase aliases for sellerEmail / localId so
// index.html's merge helpers match either casing.
function shapeListingForClient(r) {
  return {
    ...r,
    sellerEmail: r.seller_email || null,
    localId: r.local_id || null,
  };
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
// POST /api/seller/listings — Create a marketplace listing
// Writes to seller_listings (NOT products), mapped to every column the
// frontend expects to read back.
// ═══════════════════════════════════════════════════════════════
router.post('/listings', requireAuth, requireSeller, async (req, res) => {
  try {
    if (!req.body || !req.body.name || !req.body.price || Number(req.body.price) <= 0) {
      return res.status(400).json({ error: 'Name and valid price required' });
    }

    const row = buildListingRow(req.body, req.user);

    // If a row with this local_id already exists for this seller, UPDATE
    // instead of INSERT — prevents duplicates when the frontend retries a
    // sync after a network blip. This also makes listing edits work.
    if (row.local_id) {
      const { data: existing } = await supabase
        .from('seller_listings')
        .select('id, seller_email, status')
        .eq('local_id', row.local_id)
        .limit(1);

      if (existing && existing.length) {
        const found = existing[0];
        const ownerOk = !found.seller_email || found.seller_email.toLowerCase() === row.seller_email;
        if (!ownerOk && !isAdminUser(req.user)) {
          return res.status(403).json({ error: 'Not your listing' });
        }
        // Revive if it had been soft-deleted — user is creating again
        const updatePayload = { ...row, status: 'active', updated_at: new Date().toISOString() };
        delete updatePayload.seller_id; // don't clobber original seller_id
        const { data: upd, error: updErr } = await supabase
          .from('seller_listings')
          .update(updatePayload)
          .eq('id', found.id)
          .select()
          .single();
        if (updErr) throw updErr;
        return res.json({ listing: shapeListingForClient(upd), updated: true });
      }
    }

    const { data, error } = await supabase
      .from('seller_listings')
      .insert(row)
      .select()
      .single();

    if (error) throw error;
    return res.json({ listing: shapeListingForClient(data) });
  } catch (err) {
    console.error('Listing create error:', err);
    return res.status(500).json({ error: 'Failed to create listing', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/seller/listings/all — Public shop feed
// Returns every active listing plus a sellers-by-email lookup. This is
// what loadDynamicListings() on the shop page calls.
//
// IMPORTANT: we deliberately exclude the `photos` and `images` columns —
// they are base64-encoded data URLs averaging ~400KB per row, with some
// rows over 6MB. Selecting them across all rows produces a multi-megabyte
// response that times out Render's 15s gateway (502). The shop grid falls
// back to emoji/color placeholders when `photos` is absent. A separate
// endpoint below fetches full photos for a single listing on demand.
// ═══════════════════════════════════════════════════════════════
const LIST_COLUMNS = [
  'id', 'seller_id', 'seller_email', 'local_id',
  'name', 'title', 'brand', 'category',
  'price', 'color', 'emoji', 'style',
  'size', 'sizes', 'condition', 'return_window', 'ship_days',
  'stock', 'description', 'status',
  'created_at', 'updated_at',
].join(', ');

router.get('/listings/all', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('seller_listings')
      .select(LIST_COLUMNS)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const listings = (data || []).map(shapeListingForClient);

    const sellers = {};
    listings.forEach(l => {
      const key = l.sellerEmail;
      if (key && !sellers[key]) {
        sellers[key] = {
          id: 'dyn_' + key.replace(/[^a-z0-9]/gi, '_'),
          name: l.brand || 'Seller',
          email: key,
          handle: '@' + (l.brand || 'seller').toLowerCase().replace(/\s+/g, ''),
          avatar: '🏪',
          bio: 'Independent seller on Outfitd',
          verified: true,
        };
      }
    });

    return res.json({ listings, sellers });
  } catch (err) {
    console.error('[listings/all] error:', err);
    return res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/seller/listings/:id/photos — Fetch photos for one listing
// Lazy photo loader. The shop feed omits photos for payload reasons;
// when a user opens a product, the client can call this to hydrate.
// ═══════════════════════════════════════════════════════════════
router.get('/listings/:id/photos', async (req, res) => {
  try {
    const rawId = String(req.params.id || '').trim();
    if (!rawId) return res.status(400).json({ error: 'id required' });

    const candidates = new Set([rawId]);
    if (rawId.startsWith('dyn_')) candidates.add(rawId.slice(4));
    else candidates.add('dyn_' + rawId);
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);

    let row = null;
    {
      const { data } = await supabase
        .from('seller_listings')
        .select('id, photos, images')
        .in('local_id', Array.from(candidates))
        .limit(1);
      if (data && data.length) row = data[0];
    }
    if (!row && looksLikeUuid) {
      const { data } = await supabase
        .from('seller_listings')
        .select('id, photos, images')
        .eq('id', rawId)
        .limit(1);
      if (data && data.length) row = data[0];
    }

    if (!row) return res.json({ photos: [] });

    // Extract photos tolerantly — the column might store:
    //   • a JSON array:   ["data:image/...", "..."]
    //   • a JSON-encoded string: '["data:image/..."]'
    //   • a single string: "data:image/..."
    //   • null / undefined
    function extractPhotos(field) {
      if (!field) return [];
      if (Array.isArray(field)) return field.filter(Boolean);
      if (typeof field === 'string') {
        const s = field.trim();
        if (!s) return [];
        if (s.charAt(0) === '[') {
          try {
            const parsed = JSON.parse(s);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
          } catch (_) { /* fall through */ }
        }
        return [s];
      }
      if (typeof field === 'object') {
        // jsonb could come back as an object of numeric keys; coerce to array
        const vals = Object.values(field).filter(Boolean);
        if (vals.length) return vals;
      }
      return [];
    }

    const fromPhotos = extractPhotos(row.photos);
    const fromImages = extractPhotos(row.images);
    const photos = fromPhotos.length ? fromPhotos : fromImages;

    // Cache photos aggressively — they're large and rarely change. Browsers
    // will serve from cache on refresh, avoiding re-fetching megabytes of
    // base64 data every page load.
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return res.json({ photos });
  } catch (err) {
    console.error('[listings photos] error:', err);
    return res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/seller/listings — Get one seller's listings
// - Defaults to the caller's own email
// - Accepts ?email=xxx only for admin callers; non-admins are silently
//   clamped to their own email so one seller can never enumerate another
// ═══════════════════════════════════════════════════════════════
router.get('/listings', requireAuth, async (req, res) => {
  try {
    const callerEmail = (req.user.email || '').toLowerCase().trim();
    const queryEmail = String(req.query.email || '').toLowerCase().trim();
    const admin = isAdminUser(req.user);

    let targetEmail = queryEmail || callerEmail;
    if (!admin && callerEmail && targetEmail !== callerEmail) {
      targetEmail = callerEmail;
    }
    if (!targetEmail) {
      return res.status(400).json({ error: 'email required' });
    }

    const { data, error } = await supabase
      .from('seller_listings')
      .select('*')
      .ilike('seller_email', targetEmail)
      .neq('status', 'deleted')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ listings: (data || []).map(shapeListingForClient) });
  } catch (err) {
    console.error('[listings GET] error:', err);
    return res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DELETE /api/seller/listings/:id — Soft-delete a listing
// - Matches by UUID, local_id, or dyn_-prefixed local_id
// - Idempotent: missing rows return ok:true so client retries are safe
// - Owner-or-admin enforcement
// ═══════════════════════════════════════════════════════════════
router.delete('/listings/:id', requireAuth, async (req, res) => {
  try {
    const rawId = String(req.params.id || '').trim();
    if (!rawId) return res.status(400).json({ error: 'id required' });

    const callerEmail = (req.user.email || '').toLowerCase().trim();
    const admin = isAdminUser(req.user);

    // Collect candidate IDs: raw, with dyn_ stripped, with dyn_ added
    const candidates = new Set([rawId]);
    if (rawId.startsWith('dyn_')) candidates.add(rawId.slice(4));
    else candidates.add('dyn_' + rawId);
    const candidateArr = Array.from(candidates);

    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);

    // Locate the row
    let target = null;
    {
      const { data } = await supabase
        .from('seller_listings')
        .select('id, seller_email, local_id, status')
        .in('local_id', candidateArr)
        .limit(1);
      if (data && data.length) target = data[0];
    }
    if (!target && looksLikeUuid) {
      const { data } = await supabase
        .from('seller_listings')
        .select('id, seller_email, local_id, status')
        .eq('id', rawId)
        .limit(1);
      if (data && data.length) target = data[0];
    }

    if (!target) {
      // Idempotent — client can safely retry without tripping on 404s
      return res.json({ ok: true, alreadyDeleted: true });
    }

    const rowEmail = (target.seller_email || '').toLowerCase();
    if (!admin && rowEmail && rowEmail !== callerEmail) {
      return res.status(403).json({ error: 'Not your listing' });
    }

    const { error: updErr } = await supabase
      .from('seller_listings')
      .update({ status: 'deleted', updated_at: new Date().toISOString() })
      .eq('id', target.id);

    if (updErr) throw updErr;
    return res.json({ ok: true, id: target.id, local_id: target.local_id });
  } catch (err) {
    console.error('[listings DELETE] error:', err);
    return res.status(500).json({ error: 'Delete failed', detail: err.message });
  }
});

module.exports = router;
