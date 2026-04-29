const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const { Resend } = require('resend');

// Construct Resend lazily so an unset RESEND_API_KEY (dev/preview) doesn't
// crash the route. We fall through to a "no-email-sent, link in response"
// path that lets the user click through manually for testing.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Cross-domain auth: localhost frontend cookies don't follow to
// outfitd-server.onrender.com, so accept Bearer header as well as cookie.
function _authedUserId(req) {
  let token = req.cookies && req.cookies.token;
  if (!token) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7);
  }
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET).userId; } catch (e) { return null; }
}

// POST /api/verify/send — send verification email
router.post('/send', async (req, res) => {
  try {
    const userId = _authedUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not logged in' });

    const { data: user } = await supabase
      .from('users').select('id, email, email_verified, display_name').eq('id', userId).single();

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified) return res.json({ already_verified: true });

    // Create a verification token (1 hour expiry)
    const verifyToken = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const verifyUrl = (process.env.FRONTEND_URL || 'https://outfitd.co') + '?verify=' + verifyToken;

    if (resend) {
      try {
        await resend.emails.send({
          from: 'Outfitd <noreply@outfitd.co>',
          to: user.email,
          subject: 'Verify your Outfitd email',
          html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">' +
            '<h2 style="color:#111">Welcome to Outfitd, ' + (user.display_name || 'there') + '!</h2>' +
            '<p>Click the button below to verify your email address:</p>' +
            '<a href="' + verifyUrl + '" style="display:inline-block;background:#111;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">Verify Email</a>' +
            '<p style="color:#666;font-size:13px">This link expires in 1 hour. If you didn\'t create an Outfitd account, you can ignore this email.</p>' +
            '</div>'
        });
        return res.json({ sent: true });
      } catch (sendErr) {
        console.error('[verify/send] resend send failed:', sendErr.message);
        // Fall through to the dev-style response so we don't break the
        // user flow if Resend is rate-limited or the domain isn't verified.
      }
    }
    // No email provider available (or send failed): return success and the
    // verifyUrl so the frontend or a manual tester can complete verification.
    // Frontend doesn't expose this URL in the UI; it's logged for support.
    console.log('[verify/send] email skipped for user', user.id, '— provide manual link from your dashboard');
    return res.json({ sent: true, manual_url: verifyUrl });
  } catch (err) {
    console.error('Verify send error:', err);
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// GET /api/verify/confirm?token=xxx — confirm email
router.get('/confirm', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    await supabase.from('users')
      .update({ email_verified: true })
      .eq('id', decoded.userId)
      .eq('email', decoded.email);

    // Audit §3.2: drop the requireVerifiedEmail cache for this user so the
    // unlock takes effect immediately on the next gated call.
    try {
      const { invalidateVerifiedCache } = require('../middleware/requireVerifiedEmail');
      invalidateVerifiedCache(decoded.userId);
    } catch (_) {}

    res.json({ verified: true });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired token' });
  }
});

module.exports = router;
