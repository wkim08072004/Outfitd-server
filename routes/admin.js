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

module.exports = router;

