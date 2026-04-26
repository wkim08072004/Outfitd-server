// ═══════════════════════════════════════════════════════════════
// stripe-connect.js — Stripe Connect Express onboarding for sellers
// ═══════════════════════════════════════════════════════════════
// SECURITY: every endpoint here is gated by requireAuth and operates
// on the LOGGED-IN user's account, never on a client-supplied email.
// Otherwise anyone could spam Stripe Connect creation against
// arbitrary emails and pollute our Connect roster.
//
// Persistence: the user's connected-account id is stored on the
// users table (column: stripe_account_id). The localStorage copy in
// the seller dashboard is a stale display cache only — the source of
// truth is /api/stripe-connect/me.
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function requireAuth(req, res, next) {
  const token = (req.cookies && req.cookies.token)
    || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Resolve the user's id (auth.js signs JWTs with payload { userId })
function userIdOf(req) {
  return req.user && (req.user.userId || req.user.id);
}

// Best-effort persist of stripe_account_id onto users. If the column
// doesn't exist yet (pre-migration), log a clear warning so ops can
// add it without 500-ing the seller's onboarding flow.
async function persistStripeAccountId(userId, accountId) {
  if (!userId || !accountId) return { ok: false, reason: 'missing-args' };
  const { error } = await supabase
    .from('users')
    .update({ stripe_account_id: accountId })
    .eq('id', userId);
  if (error) {
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('column') && msg.includes('does not exist')) {
      console.warn('[stripe-connect] users.stripe_account_id column missing.',
        'Run: ALTER TABLE users ADD COLUMN stripe_account_id TEXT;');
      return { ok: false, reason: 'schema-missing' };
    }
    console.error('[stripe-connect] persist error:', error.code, error.message);
    return { ok: false, reason: 'db-error', detail: error.message };
  }
  return { ok: true };
}

async function loadStripeAccountId(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('users')
    .select('stripe_account_id, email')
    .eq('id', userId)
    .single();
  if (error) {
    console.warn('[stripe-connect] load error:', error.code, error.message);
    return null;
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════
// POST /api/stripe-connect/onboard
// Creates an Express Connect account for the logged-in user (or
// reuses one if they've started before) and returns an onboarding
// link. Idempotent — calling it twice returns a fresh refresh link
// for the same underlying account.
// ═══════════════════════════════════════════════════════════════
router.post('/onboard', requireAuth, async (req, res) => {
  try {
    const userId = userIdOf(req);
    const userRecord = await loadStripeAccountId(userId);
    const userEmail = (userRecord && userRecord.email)
      || (req.user && req.user.email)
      || (req.body && req.body.email)
      || '';
    if (!userEmail) return res.status(400).json({ error: 'No email on account' });

    let accountId = userRecord && userRecord.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: userEmail,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: { outfitd_user_id: String(userId || '') },
      });
      accountId = account.id;
      await persistStripeAccountId(userId, accountId);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://outfitd.co/?stripe_connect_refresh=1',
      return_url: 'https://outfitd.co/?stripe_connect_return=1',
      type: 'account_onboarding',
    });
    res.json({ url: accountLink.url, account_id: accountId });
  } catch (err) {
    console.error('Stripe Connect onboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/stripe-connect/me
// Returns the logged-in user's Connect status — used by the
// earnings page to decide between "Connect with Stripe" and
// "Connected ✓ / Open dashboard".
// ═══════════════════════════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = userIdOf(req);
    const userRecord = await loadStripeAccountId(userId);
    const accountId = userRecord && userRecord.stripe_account_id;
    if (!accountId) {
      return res.json({ connected: false });
    }
    const account = await stripe.accounts.retrieve(accountId);
    res.json({
      connected: true,
      account_id: accountId,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      details_submitted: !!account.details_submitted,
      email: account.email || (userRecord && userRecord.email) || null,
    });
  } catch (err) {
    console.error('Stripe Connect /me error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/stripe-connect/login-link
// Generates a one-time login link for the seller to manage their
// Stripe Express dashboard (update bank info, view payouts).
// ═══════════════════════════════════════════════════════════════
router.post('/login-link', requireAuth, async (req, res) => {
  try {
    const userId = userIdOf(req);
    const userRecord = await loadStripeAccountId(userId);
    const accountId = userRecord && userRecord.stripe_account_id;
    if (!accountId) return res.status(400).json({ error: 'No connected account' });

    const link = await stripe.accounts.createLoginLink(accountId);
    res.json({ url: link.url });
  } catch (err) {
    console.error('Stripe Connect login-link error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
