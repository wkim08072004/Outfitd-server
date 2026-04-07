const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper: sign tokens & set cookies
function issueTokens(res, userId) {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

  const cookieOpts = (maxAge) => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge
  });

  res.cookie('token', token, cookieOpts(15 * 60 * 1000));
  res.cookie('refreshToken', refreshToken, cookieOpts(7 * 24 * 60 * 60 * 1000));
}

// Safe user fields to return (never send password_hash)
const SAFE_SELECT = 'id, email, handle, display_name, role, avatar_url, bio, op_balance, cash_balance, store_credits, subscription, login_streak, referral_code';

// ── SIGNUP ──────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { email, password, handle, displayName } = req.body;

    if (!email || !password || !handle)
      return res.status(400).json({ error: 'Email, password and handle are required' });

    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Check reserved usernames
    const reserved = ['admin','outfitd','support','moderator','system','official','staff','mod'];
    if (reserved.includes(handle.toLowerCase().replace('@', '')))
      return res.status(400).json({ error: 'That username is not available' });

    // Check if email or handle already exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${email},handle.eq.${handle}`)
      .limit(1);

    if (existing && existing.length > 0)
      return res.status(400).json({ error: 'Email or username already taken' });

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Generate referral code
    const referral_code = 'OFD-' + handle.toUpperCase().replace('@','').slice(0,4) + Math.random().toString(36).slice(2,6).toUpperCase();

    // Insert user
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        handle: handle.toLowerCase().replace('@',''),
        display_name: displayName || handle,
        password_hash,
        referral_code
      })
      .select(SAFE_SELECT)
      .single();

    if (error) throw error;

    issueTokens(res, user.id);
    res.status(201).json({ user });

  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ── LOGIN ───────────────────────────────────────────────
const DUMMY_HASH = '$2a$12$dummyhashfortimingattackprevention1234567890abcdef';

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    // Look up user
    const { data: users } = await supabase
      .from('users')
      .select(SAFE_SELECT + ', password_hash')
      .or(`email.eq.${email.toLowerCase()},handle.eq.${email.toLowerCase().replace('@','')}`)
      .limit(1);

    const user = users && users[0];

    // Always run bcrypt even if user not found (prevents timing attacks)
    const match = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, DUMMY_HASH);

    if (!user || !match)
      return res.status(401).json({ error: 'Invalid credentials' });

    // Update login streak
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from('users').update({ last_login_date: today }).eq('id', user.id);

    issueTokens(res, user.id);

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── GOOGLE OAUTH ────────────────────────────────────────
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const { sub, email, name, picture } = payload;
    const socialId = 'google_' + sub;

    // Check if user already exists (by social_id or email)
    const { data: existing } = await supabase
      .from('users')
      .select(SAFE_SELECT)
      .or(`social_id.eq.${socialId},email.eq.${email.toLowerCase()}`)
      .limit(1);

    let user;

    if (existing && existing.length > 0) {
      user = existing[0];
      // Link social_id if they signed up with email first
      if (!user.social_id) {
        await supabase.from('users').update({
          social_id: socialId,
          social_provider: 'google',
          avatar_url: user.avatar_url || picture
        }).eq('id', user.id);
      }
    } else {
      // Create new user
      const handle = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      const referral_code = 'OFD-' + handle.toUpperCase().slice(0,4) + Math.random().toString(36).slice(2,6).toUpperCase();

      // Check if handle taken, append random if so
      const { data: handleCheck } = await supabase.from('users').select('id').eq('handle', handle).limit(1);
      const finalHandle = (handleCheck && handleCheck.length > 0)
        ? handle + Math.random().toString(36).slice(2,5)
        : handle;

      const { data: newUser, error } = await supabase
        .from('users')
        .insert({
          email: email.toLowerCase(),
          handle: finalHandle,
          display_name: name || finalHandle,
          avatar_url: picture || null,
          social_id: socialId,
          social_provider: 'google',
          email_verified: true,
          referral_code
        })
        .select(SAFE_SELECT)
        .single();

      if (error) throw error;
      user = newUser;
    }

    // Update login date
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from('users').update({ last_login_date: today }).eq('id', user.id);

    issueTokens(res, user.id);
    res.json({ user });

  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Google login failed' });
  }
});

// ── LOGOUT ──────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('refreshToken');
  res.json({ success: true });
});

// ── ME (get current user) ──────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select(SAFE_SELECT)
      .eq('id', decoded.userId)
      .single();

    if (error || !user) return res.status(401).json({ error: 'User not found' });

    res.json({ user });

  } catch (err) {
    res.status(401).json({ error: 'Invalid session' });
  }
});

module.exports = router;
