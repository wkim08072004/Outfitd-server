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
  const userId = userIdOf(req);
  // Step 1: load existing record so we don't create duplicate Connect accounts.
  // Schema-missing case is handled gracefully — the Stripe path still runs.
  let userRecord = null;
  try {
    userRecord = await loadStripeAccountId(userId);
  } catch (loadErr) {
    console.warn('[stripe-connect] /onboard load step warning:', loadErr.message);
  }

  const userEmail = (userRecord && userRecord.email)
    || (req.user && req.user.email)
    || (req.body && req.body.email)
    || '';
  if (!userEmail) {
    return res.status(400).json({
      error: 'no_email',
      message: 'No email on account — set a contact email in Settings before connecting Stripe.',
    });
  }

  // Step 2: create or reuse Stripe Connect account
  let accountId = userRecord && userRecord.stripe_account_id;
  if (!accountId) {
    try {
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
    } catch (stripeErr) {
      console.error('[stripe-connect] /onboard accounts.create failed:',
        stripeErr.code || '(no code)', stripeErr.type || '', stripeErr.message);
      // Detect the most common platform-misconfig case so the seller
      // sees a useful message instead of a generic 500.
      const m = (stripeErr.message || '').toLowerCase();
      if (m.includes('signed up for connect') || m.includes('platform') && m.includes('connect')) {
        return res.status(503).json({
          error: 'connect_not_activated',
          message: 'Stripe Connect is not yet activated on this Outfitd account. Visit https://dashboard.stripe.com/connect/onboarding to enable Connect, then retry.',
          stripe_message: stripeErr.message,
        });
      }
      return res.status(502).json({
        error: 'stripe_account_create_failed',
        message: 'Could not create your Stripe Connect account: ' + stripeErr.message,
        stripe_code: stripeErr.code || null,
        stripe_type: stripeErr.type || null,
      });
    }

    // Persist (best-effort — column may not exist yet)
    const persistResult = await persistStripeAccountId(userId, accountId);
    if (!persistResult.ok && persistResult.reason === 'schema-missing') {
      // Don't block onboarding; just log loudly. The seller can still
      // complete Stripe onboarding via the link we return below — they
      // just won't have it persisted across sessions until the column
      // is added.
      console.warn('[stripe-connect] proceeding without persistence —',
        'run: ALTER TABLE users ADD COLUMN stripe_account_id TEXT;');
    }
  }

  // Step 3: issue onboarding link
  try {
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://outfitd.co/?stripe_connect_refresh=1',
      return_url: 'https://outfitd.co/?stripe_connect_return=1',
      type: 'account_onboarding',
    });
    return res.json({ url: accountLink.url, account_id: accountId });
  } catch (linkErr) {
    console.error('[stripe-connect] /onboard accountLinks.create failed:',
      linkErr.code || '', linkErr.message);
    return res.status(502).json({
      error: 'stripe_account_link_failed',
      message: 'Created your account but could not generate the onboarding link: ' + linkErr.message,
      account_id: accountId,
    });
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
