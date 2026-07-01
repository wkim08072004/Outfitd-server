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

// ══════════════════════════════════════════════════════════════════
// Public profile lookup + follow/unfollow.
//   GET    /api/user/profile/:handle      → profile, counts, is_following
//   POST   /api/user/:id/follow           → follow that user
//   DELETE /api/user/:id/follow           → unfollow
//
// Profile is keyed by handle because every place we surface a user in
// the UI (trade items, shared closet members, posts) gives us the
// handle but not the UUID. The UUID returns in the response so the
// frontend can call /:id/follow without a second lookup.
// ══════════════════════════════════════════════════════════════════

// Lightweight auth that doesn't 401 — used by /profile so a guest
// could in principle view a profile read-only later. Right now the
// frontend always sends a token, but optional auth here also gives us
// is_following=null for unauthenticated callers without branching.
function optionalAuth(req, _res, next) {
  try {
    const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = { ...decoded, id: decoded.userId || decoded.id || decoded.sub || decoded.user_id };
      req.user.userId = req.user.id;
    }
  } catch (_) { /* ignore — treat as anonymous */ }
  next();
}

router.get('/profile/:handle', optionalAuth, async (req, res) => {
  const raw = String(req.params.handle || '').replace(/^@/, '').toLowerCase();
  if (!raw) return res.status(400).json({ error: 'handle required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, handle, display_name, avatar_url, bio, banner_bg, banner_photo, city, state, role, is_private')
    .eq('handle', raw)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Profile lookup failed' });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const viewerId = req.user?.id || null;
  // Counts + viewer's follow state in one round-trip each. Using
  // head:true + count:'exact' so we don't transfer the rows. Also
  // check for a pending follow request from viewer → this user so the
  // client can paint the button as REQUESTED.
  const [{ count: followers }, { count: following }, viewerLink, pendingReq] = await Promise.all([
    supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('followee_id', user.id),
    supabase.from('follows').select('followee_id', { count: 'exact', head: true }).eq('follower_id', user.id),
    viewerId && viewerId !== user.id
      ? supabase.from('follows').select('follower_id').eq('follower_id', viewerId).eq('followee_id', user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    viewerId && viewerId !== user.id && user.is_private
      ? supabase.from('follow_requests').select('requester_id').eq('requester_id', viewerId).eq('target_id', user.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const isSelf = viewerId === user.id;
  const isFollowing = !!viewerLink.data;
  const followRequestPending = !!pendingReq.data;
  // Posts are viewable when the account is public, or the viewer is the
  // owner, or the viewer follows this user. Everything else on the profile
  // (handle, bio, banner, avatar, counts) stays public so follow flows work.
  const canViewPosts = !user.is_private || isSelf || isFollowing;

  res.json({
    user: {
      id: user.id,
      handle: user.handle,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      bio: user.bio,
      banner_bg: user.banner_bg,
      banner_photo: user.banner_photo,
      city: user.city,
      state: user.state,
      role: user.role,
      is_private: !!user.is_private,
    },
    followers_count: followers || 0,
    following_count: following || 0,
    is_following: isFollowing,
    is_self: isSelf,
    can_view_posts: canViewPosts,
    follow_request_pending: followRequestPending,
  });
});

router.post('/:id/follow', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const target = req.params.id;
  if (uid === target) return res.status(400).json({ error: 'Cannot follow yourself' });

  // Verify the target exists so a typo'd UUID gives a 404 instead of
  // an orphan row blocked by the FK constraint.
  const { data: t } = await supabase
    .from('users').select('id, is_private').eq('id', target).maybeSingle();
  if (!t) return res.status(404).json({ error: 'User not found' });

  // Already following? No-op, return the current accepted state so the
  // client can settle its UI without a second lookup.
  const { data: existing } = await supabase
    .from('follows').select('follower_id')
    .eq('follower_id', uid).eq('followee_id', target).maybeSingle();
  if (existing) return res.json({ ok: true, already: true, status: 'accepted' });

  // Private accounts: create a pending request instead of a follow. The
  // target has to accept via /follow-requests/:id/accept before it turns
  // into a `follows` row.
  if (t.is_private) {
    const { error } = await supabase
      .from('follow_requests').insert({ requester_id: uid, target_id: target });
    if (error) {
      if (error.code === '23505') return res.json({ ok: true, already: true, status: 'pending' });
      return res.status(500).json({ error: 'Could not send request' });
    }
    return res.status(201).json({ ok: true, status: 'pending' });
  }

  // Public: direct follow.
  const { error } = await supabase
    .from('follows').insert({ follower_id: uid, followee_id: target });
  if (error) {
    if (error.code === '23505') return res.json({ ok: true, already: true, status: 'accepted' });
    return res.status(500).json({ error: 'Could not follow' });
  }
  res.status(201).json({ ok: true, status: 'accepted' });
});

router.delete('/:id/follow', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const target = req.params.id;
  // Cancel both an active follow AND any pending request in one shot —
  // the same button is used to "unfollow", "cancel request", and just
  // "make sure I'm not connected", so we clear whichever row exists.
  const [f, r] = await Promise.all([
    supabase.from('follows').delete().eq('follower_id', uid).eq('followee_id', target),
    supabase.from('follow_requests').delete().eq('requester_id', uid).eq('target_id', target),
  ]);
  if (f.error || r.error) return res.status(500).json({ error: 'Could not unfollow' });
  res.json({ ok: true, status: 'none' });
});

// ── FOLLOW REQUESTS (inbox for private-account owners) ──
// GET  /api/user/me/follow-requests        → list pending inbound
// POST /api/user/follow-requests/:requesterId/accept
// POST /api/user/follow-requests/:requesterId/decline
//
// Accept moves the row from follow_requests → follows (in the correct
// direction: requester follows target). Decline just deletes the row.
// Both are idempotent — repeat calls return the same shape.

router.get('/me/follow-requests', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const { data: reqs, error } = await supabase
    .from('follow_requests')
    .select('requester_id, created_at')
    .eq('target_id', uid)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: 'Could not load requests' });

  const ids = (reqs || []).map(r => r.requester_id);
  if (!ids.length) return res.json({ requests: [] });

  const { data: users } = await supabase
    .from('users').select('id, handle, display_name, avatar_url').in('id', ids);
  const byId = {};
  (users || []).forEach(u => { byId[u.id] = u; });

  const out = (reqs || []).map(r => Object.assign({}, byId[r.requester_id] || { id: r.requester_id }, {
    requested_at: r.created_at,
  })).filter(x => x.handle);
  res.json({ requests: out });
});

router.post('/follow-requests/:requesterId/accept', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const requester = req.params.requesterId;
  if (uid === requester) return res.status(400).json({ error: 'Invalid request' });

  // Delete the pending row and, if it existed, insert the accepted follow.
  // Doing it in that order means a duplicate accept is a safe no-op.
  const { data: pending } = await supabase
    .from('follow_requests').select('requester_id')
    .eq('requester_id', requester).eq('target_id', uid).maybeSingle();
  if (!pending) return res.status(404).json({ error: 'Request not found' });

  await supabase.from('follow_requests').delete()
    .eq('requester_id', requester).eq('target_id', uid);
  const { error } = await supabase.from('follows')
    .insert({ follower_id: requester, followee_id: uid });
  if (error && error.code !== '23505') {
    return res.status(500).json({ error: 'Could not accept' });
  }
  res.json({ ok: true });
});

router.post('/follow-requests/:requesterId/decline', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const requester = req.params.requesterId;
  const { error } = await supabase.from('follow_requests').delete()
    .eq('requester_id', requester).eq('target_id', uid);
  if (error) return res.status(500).json({ error: 'Could not decline' });
  res.json({ ok: true });
});

// Force-remove a follower. Deletes the follows row where the caller is
// the followee, so the other user is no longer following them. Idempotent
// (no error if the row was already gone). The removed user isn't notified;
// they just silently stop seeing new posts.
router.delete('/me/followers/:followerId', requireAuth, async (req, res) => {
  const uid = req.user.userId;
  const follower = req.params.followerId;
  if (uid === follower) return res.status(400).json({ error: 'Invalid target' });
  const { error } = await supabase.from('follows').delete()
    .eq('follower_id', follower).eq('followee_id', uid);
  if (error) return res.status(500).json({ error: 'Could not remove follower' });
  res.json({ ok: true });
});

// List followers / following for a given user. Kept public so any
// signed-in viewer can browse. Returned rows are shaped for the UI
// (id/handle/display_name/avatar_url) so the frontend can render a
// list and openUserProfile(handle) on click without a second lookup.
async function _listFollowRelated(req, res, direction) {
  const uid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  // direction='followers' → who follows :id → follower_id = ?, join user on followee.follower_id
  // direction='following' → who :id follows  → followee_id via follower_id = :id
  const selfCol = direction === 'followers' ? 'followee_id' : 'follower_id';
  const otherCol = direction === 'followers' ? 'follower_id' : 'followee_id';

  const { data: links, error } = await supabase
    .from('follows')
    .select(otherCol + ', created_at')
    .eq(selfCol, uid)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: 'Could not load list' });

  const ids = (links || []).map(l => l[otherCol]).filter(Boolean);
  if (!ids.length) return res.json({ users: [] });

  const { data: users, error: uerr } = await supabase
    .from('users')
    .select('id, handle, display_name, avatar_url')
    .in('id', ids);
  if (uerr) return res.status(500).json({ error: 'Could not load users' });

  // Preserve the follows order (most recent first).
  const byId = {};
  (users || []).forEach(u => { byId[u.id] = u; });
  const ordered = ids.map(id => byId[id]).filter(Boolean);
  res.json({ users: ordered });
}

router.get('/:id/followers', requireAuth, (req, res) => _listFollowRelated(req, res, 'followers'));
router.get('/:id/following', requireAuth, (req, res) => _listFollowRelated(req, res, 'following'));

module.exports = router;
