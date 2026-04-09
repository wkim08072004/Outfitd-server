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
        sameSite: 'none',
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
        return res.status(409).json({ error: 'Email or username already taken' });

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

// ── LOGIN (supports email OR @handle) ───────────────────
const DUMMY_HASH = '$2a$12$dummyhashfortimingattackprevention1234567890abcdef';

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password)
            return res.status(400).json({ error: 'Email and password are required' });

        const input = email.trim().toLowerCase();

        // Check lockout
        if (checkLockout(input))
            return res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });

        // Determine if input is email or handle
        let users;
        if (input.includes('@') && input.includes('.')) {
            // Looks like an email
            const { data } = await supabase
                .from('users')
                .select(SAFE_SELECT + ', password_hash')
                .or(`email.eq.${input},handle.eq.${input.replace('@','')}`)
                .limit(1);
            users = data;
        } else {
            // Treat as handle
            const handle = input.replace(/^@/, '');
            const { data } = await supabase
                .from('users')
                .select(SAFE_SELECT + ', password_hash')
                .eq('handle', handle)
                .limit(1);
            users = data;
        }

        const user = users && users[0];

        // Always run bcrypt even if user not found (prevents timing attacks)
        const match = user
            ? await bcrypt.compare(password, user.password_hash)
            : await bcrypt.compare(password, DUMMY_HASH);

        if (!user || !match) {
            recordFailedAttempt(input);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Social-only accounts can't login with password
        if (!user.password_hash || user.password_hash === '__social__') {
            return res.status(401).json({ error: 'This account uses Google sign-in. Try signing in with Google.' });
        }

        clearAttempts(input);

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
        let isNew = false;

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
            isNew = true;
        }

        // Update login date
        const today = new Date().toISOString().slice(0, 10);
        await supabase.from('users').update({ last_login_date: today }).eq('id', user.id);

        issueTokens(res, user.id);
        res.json({ user, isNew });

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

// ── ME (get current user) ───────────────────────────────
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

// ── REFRESH TOKEN ───────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
        const refreshToken = req.cookies.refreshToken;
        if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });

        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        const { data: user } = await supabase
            .from('users')
            .select(SAFE_SELECT)
            .eq('id', decoded.userId)
            .single();

        if (!user) return res.status(401).json({ error: 'User not found' });

        // Issue new access token
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '15m' });
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'none',
            maxAge: 15 * 60 * 1000
        });

        res.json({ user });
  } catch (err) {
    res.clearCookie('token');
    res.clearCookie('refreshToken');
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ── ACCOUNT LOCKOUT (10 failures = 15 min lock) ────────
const _loginAttempts = {};

function checkLockout(email) {
  const key = email.toLowerCase();
  const record = _loginAttempts[key];
  if (!record) return false;
  if (record.lockedUntil && Date.now() < record.lockedUntil) return true;
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    delete _loginAttempts[key];
    return false;
  }
  return false;
}

function recordFailedAttempt(email) {
  const key = email.toLowerCase();
  if (!_loginAttempts[key]) _loginAttempts[key] = { count: 0 };
  _loginAttempts[key].count++;
  if (_loginAttempts[key].count >= 10) {
    _loginAttempts[key].lockedUntil = Date.now() + 15 * 60 * 1000;
  }
}

function clearAttempts(email) {
  delete _loginAttempts[email.toLowerCase()];
}

// ── PASSWORD CHANGE ─────────────────────────────────────
router.post('/change-password', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not logged in' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const { currentPassword, newPassword } = req.body;
        if (!newPassword || newPassword.length < 8)
            return res.status(400).json({ error: 'Password must be at least 8 characters' });

        const { data: user } = await supabase
            .from('users')
            .select('id, password_hash')
            .eq('id', decoded.userId)
            .single();

        if (!user) return res.status(404).json({ error: 'User not found' });

        // If user has a real password, verify current one
        const isSocial = !user.password_hash || user.password_hash === '__social__';
        if (!isSocial) {
            if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
            const match = await bcrypt.compare(currentPassword, user.password_hash);
            if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        await supabase.from('users').update({ password_hash: newHash }).eq('id', user.id);

        res.json({
            success: true,
            message: isSocial
                ? 'Password set successfully ✓ You can now log in with email too.'
                : 'Password updated successfully ✓'
        });
    } catch (err) {
        console.error('Password change error:', err);
        res.status(500).json({ error: 'Password change failed' });
    }
});

// ── FORGOT PASSWORD (send reset email) ──────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: user } = await supabase
      .from('users')
      .select('id, email, display_name')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (user) {
      const resetToken = jwt.sign(
        { userId: user.id, email: user.email, type: 'password_reset' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      const resetUrl = (process.env.FRONTEND_URL || 'https://outfitd.co') + '?reset=' + resetToken;

      if (process.env.RESEND_API_KEY) {
        try {
          const { Resend } = require('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: 'Outfitd <noreply@outfitd.co>',
            to: user.email,
            subject: 'Reset your Outfitd password',
            html: `
              <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
                <h2 style="letter-spacing:2px;font-size:28px;">OUTFITD</h2>
                <p>Hey ${user.display_name || 'there'},</p>
                <p>We received a request to reset your password. Click below to set a new one:</p>
                <a href="${resetUrl}" style="display:inline-block;background:#c9184a;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0;">Reset Password</a>
                <p style="color:#888;font-size:13px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
              </div>
            `
          });
        } catch (emailErr) {
          console.error('Reset email failed:', emailErr);
        }
      } else {
        console.log('RESEND_API_KEY not set. Reset URL:', resetUrl);
      }
    }

    // Always return success (don't reveal if email exists)
    res.json({ sent: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json({ sent: true });
  }
});

// ── RESET PASSWORD (verify token, set new password) ─────
router.post('/reset-password', async (req, res) => {
  try {
    const { token: resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword)
      return res.status(400).json({ error: 'Token and new password required' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }
    if (decoded.type !== 'password_reset')
      return res.status(400).json({ error: 'Invalid reset token' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await supabase.from('users').update({ password_hash: newHash }).eq('id', decoded.userId);

    issueTokens(res, decoded.userId);

    const { data: user } = await supabase
      .from('users')
      .select(SAFE_SELECT)
      .eq('id', decoded.userId)
      .single();

    res.json({ success: true, user: user || null });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── ACCOUNT DELETION ────────────────────────────────────
router.post('/delete-account', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not logged in' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Password required' });

        const { data: user } = await supabase
            .from('users')
            .select('id, password_hash')
            .eq('id', decoded.userId)
            .single();

        if (!user) return res.status(404).json({ error: 'User not found' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Incorrect password' });

        // Cascade delete — Supabase ON DELETE CASCADE handles related tables
        await supabase.from('users').delete().eq('id', user.id);

        res.clearCookie('token');
        res.clearCookie('refreshToken');
        res.json({ success: true });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Account deletion failed' });
    }
});

module.exports = router;

// ── PUBLIC CONFIG (serves Google Client ID to frontend) ─────
router.get('/google-config', (req, res) => {
    res.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
});
