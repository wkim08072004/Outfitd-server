// Audit §3.2: gate value-bearing actions behind a verified email so a
// throwaway-mailinator signup can't immediately post / buy / publish /
// cash out. Run AFTER your route's auth middleware (i.e. req.user is
// already populated from the JWT).
//
// Enforcement is OFF by default and turns on with
// STRICT_EMAIL_VERIFICATION=true on the server. Until the env flag is
// set, the middleware passes every request through — the gate is in
// place but inert, so we can ship before the email-delivery pipeline
// (Resend / DKIM / domain verification) is finalised.
//
// When ON: returns 403 with `error: 'email_not_verified'` so the
// frontend can surface a "Verify your email to continue" CTA without
// parsing prose.

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const STRICT = String(process.env.STRICT_EMAIL_VERIFICATION || '').toLowerCase() === 'true';

// Tiny in-memory cache so a single user spamming gated endpoints doesn't
// hammer the DB. 60s TTL is short enough that a freshly-verified user
// sees the unlock within a minute.
const VERIFIED_TTL_MS = 60 * 1000;
const _cache = new Map();

async function requireVerifiedEmail(req, res, next) {
  // Soft-launch mode: gate is inert until STRICT_EMAIL_VERIFICATION=true
  // is set on the server. Code paths stay wired so flipping the flag
  // later activates the gate everywhere at once.
  if (!STRICT) return next();

  const userId = req.user && (req.user.userId || req.user.id);
  if (!userId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const cached = _cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.verified) return next();
    return _send403(res);
  }
  try {
    const { data, error } = await supabase
      .from('users').select('email_verified').eq('id', userId).single();
    if (error) {
      console.warn('[requireVerifiedEmail] lookup error:', error.message);
      return res.status(500).json({ error: 'verification_check_failed' });
    }
    const verified = !!(data && data.email_verified);
    _cache.set(userId, { verified, expiresAt: Date.now() + VERIFIED_TTL_MS });
    if (verified) return next();
    return _send403(res);
  } catch (err) {
    console.warn('[requireVerifiedEmail] unexpected:', err.message);
    return res.status(500).json({ error: 'verification_check_failed' });
  }
}

function _send403(res) {
  return res.status(403).json({
    error: 'email_not_verified',
    message: 'Verify your email to continue. Check your inbox for the link, or request a new one from Settings.',
  });
}

// Allow the verify route to invalidate the cache on successful verification
// so the user doesn't have to wait up to 60s before being un-gated.
function invalidateVerifiedCache(userId) {
  if (userId) _cache.delete(userId);
}

module.exports = { requireVerifiedEmail, invalidateVerifiedCache };
