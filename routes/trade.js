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

// ══════════════════════════════════════════════════════════════════
// TRADE REQUESTS + scoped messaging (Phase 1).
//
// Replaces the old POST /api/trade/contact/:itemId stub. Structured
// request flow: requester picks an item, recipient accepts/declines,
// either side can post messages. On completion, both items flip to
// 'traded' via the DB trigger from 20260624b_trade_requests.sql.
//
// Status state machine (enforced here, NOT in the DB):
//   pending  → accepted   (recipient action)
//   pending  → declined   (recipient action)
//   pending  → cancelled  (requester action)
//   accepted → completed  (either action — return_item_id required)
//   accepted → cancelled  (either action)
//   declined / cancelled / completed: TERMINAL
// ══════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────
// POST /api/trade/requests
//   Body: { item_id, message? }
//   Creates a pending request on item_id, owned by item.owner.
// ──────────────────────────────────────────────────────────────────────
router.post('/requests', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const { item_id, message } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'item_id required' });

  // Look up the item to find recipient + validate self-trade.
  const { data: item, error: itemErr } = await supabase
    .from('closet_items')
    .select('id, owner_id, status')
    .eq('id', item_id)
    .single();
  if (itemErr || !item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'available')
    return res.status(409).json({ error: 'Item is no longer available' });
  if (item.owner_id === uid)
    return res.status(400).json({ error: "You can't request your own item" });

  // Insert. The partial unique index blocks dup pending/accepted
  // requests from the same requester on the same item — surface as 409.
  const insertRow = {
    requester_id: uid,
    recipient_id: item.owner_id,
    item_id: item.id,
    status: 'pending',
  };
  const { data: created, error: insErr } = await supabase
    .from('trade_requests')
    .insert(insertRow)
    .select()
    .single();
  if (insErr) {
    if (insErr.code === '23505') {
      return res
        .status(409)
        .json({ error: 'You already have an open request on this item' });
    }
    return res.status(500).json({ error: 'Could not create request' });
  }

  // Opening message (optional). Stored as the first thread row so the
  // recipient sees it inline rather than as a separate "intro" field.
  if (message && typeof message === 'string' && message.trim()) {
    await supabase.from('trade_request_messages').insert({
      request_id: created.id,
      sender_id: uid,
      body: message.trim().slice(0, 2000),
    });
  }

  return res.status(201).json({ request: created });
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/trade/requests/inbox  — requests sent TO me
// GET /api/trade/requests/outbox — requests I've SENT
//
//   Both return shape: { requests: [{ ...request, item, other_user,
//   unread_count, last_message_at }], unread_total }
// ──────────────────────────────────────────────────────────────────────
async function _listRequests(uid, role) {
  // role: 'recipient' (inbox) or 'requester' (outbox)
  const otherCol = role === 'recipient' ? 'requester_id' : 'recipient_id';
  const ownCol   = role === 'recipient' ? 'recipient_id' : 'requester_id';

  const { data: requests, error } = await supabase
    .from('trade_requests')
    .select('*')
    .eq(ownCol, uid)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  if (!requests || !requests.length) return { requests: [], unread_total: 0 };

  const itemIds  = [...new Set(requests.map(r => r.item_id))];
  const otherIds = [...new Set(requests.map(r => r[otherCol]))];
  const reqIds   = requests.map(r => r.id);

  const [items, others, msgAgg] = await Promise.all([
    supabase
      .from('closet_items')
      .select('id, owner_id, title, brand, category, size, condition, photos, status')
      .in('id', itemIds),
    supabase
      .from('users')
      .select('id, handle, display_name, avatar_url, city, state')
      .in('id', otherIds),
    supabase
      .from('trade_request_messages')
      .select('request_id, sender_id, read_at, created_at, body')
      .in('request_id', reqIds)
      .order('created_at', { ascending: false }),
  ]);

  const itemMap  = new Map((items.data  || []).map(x => [x.id, x]));
  const otherMap = new Map((others.data || []).map(x => [x.id, x]));

  // Per-request aggregate: unread count (messages where the OTHER side
  // sent and I haven't read) + last message snippet.
  const aggMap = new Map();
  for (const m of (msgAgg.data || [])) {
    const a = aggMap.get(m.request_id) || { unread: 0, last: null };
    if (!a.last) a.last = m;
    if (m.sender_id !== uid && !m.read_at) a.unread += 1;
    aggMap.set(m.request_id, a);
  }

  let unreadTotal = 0;
  const enriched = requests.map(r => {
    const a = aggMap.get(r.id) || { unread: 0, last: null };
    unreadTotal += a.unread;
    return {
      ...r,
      item: itemMap.get(r.item_id) || null,
      other_user: otherMap.get(r[otherCol]) || null,
      unread_count: a.unread,
      last_message_at: a.last ? a.last.created_at : null,
      last_message_preview: a.last
        ? String(a.last.body).slice(0, 80)
        : null,
    };
  });

  return { requests: enriched, unread_total: unreadTotal };
}

router.get('/requests/inbox', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const out = await _listRequests(uid, 'recipient');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'Could not load inbox' });
  }
});

router.get('/requests/outbox', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const out = await _listRequests(uid, 'requester');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'Could not load outbox' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/trade/requests/:id — full thread + both users + item
//   Only the requester or recipient can read it.
// ──────────────────────────────────────────────────────────────────────
router.get('/requests/:id', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params.id;
  const { data: r, error } = await supabase
    .from('trade_requests')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !r) return res.status(404).json({ error: 'Not found' });
  if (r.requester_id !== uid && r.recipient_id !== uid)
    return res.status(403).json({ error: 'Not your request' });

  const [item, ret, requester, recipient, messages] = await Promise.all([
    supabase
      .from('closet_items')
      .select('*')
      .eq('id', r.item_id)
      .single(),
    r.return_item_id
      ? supabase.from('closet_items').select('*').eq('id', r.return_item_id).single()
      : Promise.resolve({ data: null }),
    supabase
      .from('users')
      .select('id, handle, display_name, avatar_url, city, state')
      .eq('id', r.requester_id)
      .single(),
    supabase
      .from('users')
      .select('id, handle, display_name, avatar_url, city, state')
      .eq('id', r.recipient_id)
      .single(),
    supabase
      .from('trade_request_messages')
      .select('*')
      .eq('request_id', id)
      .order('created_at', { ascending: true }),
  ]);

  res.json({
    request: r,
    item: item.data || null,
    return_item: ret.data || null,
    requester: requester.data || null,
    recipient: recipient.data || null,
    messages: messages.data || [],
    viewer_role: r.requester_id === uid ? 'requester' : 'recipient',
  });
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/trade/requests/:id
//   Body: { action: 'accept'|'decline'|'cancel'|'complete',
//           return_item_id?: uuid }   // required for action='complete'
// ──────────────────────────────────────────────────────────────────────
router.patch('/requests/:id', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params.id;
  const { action, return_item_id } = req.body || {};
  if (!['accept', 'decline', 'cancel', 'complete'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const { data: r, error } = await supabase
    .from('trade_requests')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !r) return res.status(404).json({ error: 'Not found' });

  const isRequester = r.requester_id === uid;
  const isRecipient = r.recipient_id === uid;
  if (!isRequester && !isRecipient)
    return res.status(403).json({ error: 'Not your request' });

  // State machine + role gating.
  const updates = { updated_at: new Date().toISOString() };
  if (action === 'accept') {
    if (!isRecipient) return res.status(403).json({ error: 'Only the recipient can accept' });
    if (r.status !== 'pending') return res.status(409).json({ error: 'Already resolved' });
    updates.status = 'accepted';
  } else if (action === 'decline') {
    if (!isRecipient) return res.status(403).json({ error: 'Only the recipient can decline' });
    if (r.status !== 'pending') return res.status(409).json({ error: 'Already resolved' });
    updates.status = 'declined';
  } else if (action === 'cancel') {
    if (!['pending', 'accepted'].includes(r.status))
      return res.status(409).json({ error: 'Already resolved' });
    // Requester can cancel pending; either side can cancel accepted.
    if (r.status === 'pending' && !isRequester)
      return res.status(403).json({ error: 'Only the requester can cancel a pending request' });
    updates.status = 'cancelled';
  } else if (action === 'complete') {
    if (r.status !== 'accepted')
      return res.status(409).json({ error: 'Can only complete an accepted request' });
    if (!return_item_id)
      return res.status(400).json({ error: 'return_item_id required to complete' });
    // Validate the return item belongs to the OTHER side and is available.
    const otherSideId = isRecipient ? r.requester_id : r.recipient_id;
    // The return item is the one the RECIPIENT is giving up — i.e. it
    // must be owned by the RECIPIENT, which (depending on which side
    // calls complete) may or may not be the caller. Wait — re-read:
    // the recipient owns r.item_id; the return item belongs to the
    // REQUESTER. So return_item_id.owner === requester_id.
    const { data: retItem, error: retErr } = await supabase
      .from('closet_items')
      .select('id, owner_id, status')
      .eq('id', return_item_id)
      .single();
    if (retErr || !retItem)
      return res.status(400).json({ error: 'return_item_id not found' });
    if (retItem.owner_id !== r.requester_id)
      return res.status(400).json({ error: 'return_item_id must belong to the requester' });
    if (retItem.status !== 'available')
      return res.status(409).json({ error: 'return_item is no longer available' });
    updates.status = 'completed';
    updates.return_item_id = return_item_id;
  }

  const { data: updated, error: upErr } = await supabase
    .from('trade_requests')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (upErr) {
    // The DB trigger throws on completion without a return_item_id;
    // surface that as 400.
    if (String(upErr.message || '').includes('return_item_id required')) {
      return res.status(400).json({ error: 'return_item_id required to complete' });
    }
    return res.status(500).json({ error: 'Could not update request' });
  }
  res.json({ request: updated });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/trade/requests/:id/messages
//   Body: { body }
// ──────────────────────────────────────────────────────────────────────
router.post('/requests/:id/messages', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params.id;
  const body = (req.body && req.body.body) || '';
  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'body required' });
  }

  const { data: r, error } = await supabase
    .from('trade_requests')
    .select('id, requester_id, recipient_id, status')
    .eq('id', id)
    .single();
  if (error || !r) return res.status(404).json({ error: 'Not found' });
  if (r.requester_id !== uid && r.recipient_id !== uid)
    return res.status(403).json({ error: 'Not your request' });
  if (['declined', 'cancelled', 'completed'].includes(r.status))
    return res.status(409).json({ error: 'Cannot message a closed request' });

  const { data: msg, error: msgErr } = await supabase
    .from('trade_request_messages')
    .insert({
      request_id: id,
      sender_id: uid,
      body: body.trim().slice(0, 2000),
    })
    .select()
    .single();
  if (msgErr) return res.status(500).json({ error: 'Could not send message' });

  // Touch parent so it sorts to the top of the inbox.
  await supabase
    .from('trade_requests')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id);

  res.status(201).json({ message: msg });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/trade/requests/:id/read
//   Marks all messages in this request that were NOT sent by me as
//   read. Idempotent.
// ──────────────────────────────────────────────────────────────────────
router.post('/requests/:id/read', requireAuth, async (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params.id;
  const { data: r, error } = await supabase
    .from('trade_requests')
    .select('id, requester_id, recipient_id')
    .eq('id', id)
    .single();
  if (error || !r) return res.status(404).json({ error: 'Not found' });
  if (r.requester_id !== uid && r.recipient_id !== uid)
    return res.status(403).json({ error: 'Not your request' });

  const { error: upErr } = await supabase
    .from('trade_request_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('request_id', id)
    .neq('sender_id', uid)
    .is('read_at', null);
  if (upErr) return res.status(500).json({ error: 'Could not mark read' });
  res.json({ ok: true });
});

module.exports = router;
