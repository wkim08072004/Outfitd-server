const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');

// POST /api/admin/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const { data: user } = await supabase
      .from('users')
      .select('id, email, handle, display_name, role, password_hash')
      .eq('email', email.toLowerCase())
      .single();

    if (!user || user.role !== 'admin')
      return res.status(403).json({ error: 'Not authorized' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '4h' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 4 * 60 * 60 * 1000
    });

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Middleware: require admin
function requireAdmin(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin')
      return res.status(403).json({ error: 'Admin only' });
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid session' });
  }
}

// GET /api/admin/verify — check if current session is admin
router.get('/verify', requireAdmin, (req, res) => {
  res.json({ admin: true, userId: req.user.userId });
});

// POST /api/admin/promote/:id — make a user admin (admin only)
router.post('/promote/:id', requireAdmin, async (req, res) => {
  try {
    await supabase.from('users').update({ role: 'admin' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Promote failed' });
  }
});

// ── COOKIE CONSENT ──────────────────────────────────────────

// POST /api/admin/consent — save cookie consent for logged-in user
router.post('/consent', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.json({ saved: false }); // guest, skip

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { choice } = req.body;

    await supabase.from('users')
      .update({ cookie_consent: choice === 'accept' })
      .eq('id', decoded.userId);

    res.json({ saved: true });
  } catch (err) {
    res.json({ saved: false });
  }
});

// GET /api/admin/consent — check consent status
router.get('/consent', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.json({ consent: null });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user } = await supabase
      .from('users').select('cookie_consent').eq('id', decoded.userId).single();

    res.json({ consent: user ? user.cookie_consent : null });
  } catch (err) {
    res.json({ consent: null });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Moderation review queue. See lib/moderation/README.md for the full
// pipeline. All endpoints require an admin JWT (requireAdmin above).
// ──────────────────────────────────────────────────────────────────────

const moderation = require('../lib/moderation');

// GET /api/admin/moderation/queue — pending soft-flagged uploads.
router.get('/moderation/queue', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('flagged_uploads')
      .select('id, sha256, uploader_id, image_url, reasons, status, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    // Hydrate uploader handle so the queue is reviewable at a glance.
    const uploaderIds = Array.from(new Set((data || []).map(r => r.uploader_id).filter(Boolean)));
    let userMap = {};
    if (uploaderIds.length) {
      const { data: users } = await supabase
        .from('users').select('id, handle, email').in('id', uploaderIds);
      (users || []).forEach(u => { userMap[u.id] = u; });
    }
    const items = (data || []).map(r => ({
      id: r.id,
      sha256: r.sha256,
      uploader: userMap[r.uploader_id] || null,
      image_url: r.image_url,
      reasons: r.reasons || [],
      created_at: r.created_at,
    }));
    res.json({ items });
  } catch (err) {
    console.error('moderation queue error:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
});

// POST /api/admin/moderation/:id/approve — clear flag, leave image live.
router.post('/moderation/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('flagged_uploads')
      .update({
        status: 'approved',
        reviewed_by: req.user.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('moderation approve error:', err);
    res.status(500).json({ error: 'Failed to approve' });
  }
});

// POST /api/admin/moderation/:id/reject — mark rejected AND ban the
// hash so re-uploads are blocked at step 1 of the pipeline.
router.post('/moderation/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { data: row, error: loadErr } = await supabase
      .from('flagged_uploads')
      .select('sha256')
      .eq('id', req.params.id)
      .single();
    if (loadErr) throw loadErr;

    if (row?.sha256) {
      await moderation.banHash(row.sha256, 'admin_reject', req.user.userId);
    }

    const { error } = await supabase
      .from('flagged_uploads')
      .update({
        status: 'rejected',
        reviewed_by: req.user.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('moderation reject error:', err);
    res.status(500).json({ error: 'Failed to reject' });
  }
});

module.exports = router;

