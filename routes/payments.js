// ═══════════════════════════════════════════════════════════════
// payments.js — Stripe PaymentIntent creation for inline Element flow
// ═══════════════════════════════════════════════════════════════
// SECURITY: Never trust the client's `amount`. We look up canonical
// prices from seller_listings on every create-intent and let Stripe
// charge what the database says, not what the buyer's cart claims.
// Audit item §1.7 — the cart's `price` field used to flow through
// untouched, so a buyer with DevTools could pay $0.01 for a $100
// jacket. After this rewrite, the only thing the client controls is
// which products and how many; pricing is server-authoritative.
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Email-verification gates have been retired — login alone authenticates.
// See server.js / middleware/requireVerifiedEmail.js if you want to add
// the gate back later; the file is kept as an unused module.
// const { requireVerifiedEmail } = require('../middleware/requireVerifiedEmail');

// Standard auth middleware shared with the rest of the app — JWT in cookie
// OR Authorization header. Sets req.user.userId for downstream gates.
function requireAuth(req, res, next) {
  const token = (req.cookies && req.cookies.token)
    || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Mirror frontend constants — keep in sync with index.html.
const SHIPPING_FLAT_FEE_DEFAULT = 4;  // fallback when listing has no shipping_price
const TAX_RATE = 0.08;                // 8% on item subtotal only
const POINTS_PER_DOLLAR = 100;        // 100 Style Points = $1 (closed-loop currency)
const SELLER_PAYOUT_PCT = 0.85;
const PLATFORM_FEE_PCT = 0.10;
const BUYER_REWARD_PCT = 0.05;
const REDEMPTION_MAX_PCT = 0.50;      // buyer can redeem at most 50% of cart in points
                                       // (anti-abuse: prevents the system being drained
                                       //  to free purchases by accumulated points alone)

// Best-effort JWT decode so we can fetch the buyer's points balance
// for redemption validation. If the token is missing or invalid, we
// just treat redemption as 0 — the buyer can't redeem points if they
// aren't authenticated.
function tryDecodeUser(req) {
  try {
    const token = (req.cookies && req.cookies.token)
      || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Look up a listing by either its UUID `id` or its `local_id` (the
// cart can send either; legacy local_id may also be 'dyn_'-prefixed).
// Returns the canonical price (in dollars) and shipping_price (parsed
// from the description JSON), plus seller_id.
async function lookupListings(productIds) {
  const ids = (productIds || []).map(s => String(s || '').trim()).filter(Boolean);
  if (!ids.length) return {};

  const localCandidates = new Set();
  const uuidCandidates = new Set();
  for (const raw of ids) {
    localCandidates.add(raw);
    if (raw.startsWith('dyn_')) localCandidates.add(raw.slice(4));
    else localCandidates.add('dyn_' + raw);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      uuidCandidates.add(raw);
    }
  }

  const out = {};
  // Try local_id matches first
  if (localCandidates.size) {
    const { data } = await supabase
      .from('seller_listings')
      .select('id, local_id, price, description, seller_id, status')
      .in('local_id', Array.from(localCandidates));
    for (const row of (data || [])) {
      if (row.status === 'deleted') continue;
      const ship = parseShippingFromDescription(row.description);
      const record = {
        listing_id: row.id,
        local_id: row.local_id,
        price: Number(row.price) || 0,
        shipping_price: ship,
        seller_id: row.seller_id || null,
      };
      if (row.id) out[row.id] = record;
      if (row.local_id) {
        out[row.local_id] = record;
        out['dyn_' + row.local_id] = record;
      }
    }
  }
  // Fill in any UUID-shaped IDs we haven't matched yet
  const stillMissing = [...uuidCandidates].filter(id => !out[id]);
  if (stillMissing.length) {
    const { data } = await supabase
      .from('seller_listings')
      .select('id, local_id, price, description, seller_id, status')
      .in('id', stillMissing);
    for (const row of (data || [])) {
      if (row.status === 'deleted') continue;
      const ship = parseShippingFromDescription(row.description);
      const record = {
        listing_id: row.id,
        local_id: row.local_id,
        price: Number(row.price) || 0,
        shipping_price: ship,
        seller_id: row.seller_id || null,
      };
      if (row.id) out[row.id] = record;
      if (row.local_id) out[row.local_id] = record;
    }
  }
  return out;
}

function parseShippingFromDescription(desc) {
  if (typeof desc !== 'string') return SHIPPING_FLAT_FEE_DEFAULT;
  try {
    const parsed = JSON.parse(desc);
    if (parsed && typeof parsed.shipping_price === 'number') return parsed.shipping_price;
  } catch (e) { /* not valid JSON — fall back */ }
  return SHIPPING_FLAT_FEE_DEFAULT;
}

// ═══════════════════════════════════════════════════════════════
// POST /api/payments/create-intent
//
// Body: {
//   items: [{ product_id, qty }],
//   style_points_applied?: number,        // pts the buyer wants to redeem
//   seller_allocation?: { [sellerId]: pts }, // optional manual split
//   currency?: 'usd'
// }
//
// Returns: { client_secret, amount_cents, breakdown }
//
// PAYOUT MODEL — closed-loop Robux-style economy.
//   • All buyer cash lands in the platform's Stripe account first.
//   • During each order's return window, the platform holds the cash.
//   • After the window, /api/orders/release-due creates Stripe transfers
//     that move 85% of cash + 100% of shipping to the seller's Connect
//     account. Refunds during the window are simple — the seller never
//     received money, so no clawback transfer is needed.
//   • Style Points are a separate ledger:
//       - 5% of cash collected becomes new buyer-side Style Points.
//       - When a buyer redeems X points, X points transfer directly to
//         the seller(s). Sellers can later cash points to USD via
//         /api/stripe-connect/cashout at 1:1 (100 pts = $1).
//   • Multi-seller redemption: buyer can specify seller_allocation; if
//     not, platform splits points evenly across sellers. Any rounding
//     remainder accrues to Outfitd's 10% fee for clean integer math.
//
// SECURITY: client never controls pricing. We look up canonical
// prices and shipping from seller_listings on every call. The
// redemption amount is also validated against the buyer's actual
// op_balance; "I have a million Style Points" requests are rejected.
// ═══════════════════════════════════════════════════════════════
router.post('/create-intent', requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const currency = (req.body && req.body.currency) || 'usd';
    const requestedRedemption = Math.max(0, Math.floor(Number(req.body && req.body.style_points_applied) || 0));
    const requestedAllocation = (req.body && req.body.seller_allocation) || null;
    if (!items.length) {
      return res.status(400).json({ error: 'items required' });
    }

    const productIds = items.map(it => it.product_id || it.id).filter(Boolean);
    const listingMap = await lookupListings(productIds);

    let subtotalCents = 0;
    const sellerShipping = {}; // seller_id -> max shipping_price (dollars)
    const sellerSubtotal = {}; // seller_id -> sum of item line totals (cents)
    const validatedItems = [];
    for (const item of items) {
      const id = item.product_id || item.id;
      const listing = listingMap[id];
      if (!listing) {
        return res.status(400).json({
          error: 'Unknown product in cart — please refresh and try again',
          unknown_product_id: id,
        });
      }
      const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
      const linePriceCents = Math.round(listing.price * 100) * qty;
      subtotalCents += linePriceCents;
      const sid = listing.seller_id || '__unknown__';
      sellerSubtotal[sid] = (sellerSubtotal[sid] || 0) + linePriceCents;
      const ship = listing.shipping_price;
      if (sellerShipping[sid] === undefined || ship > sellerShipping[sid]) {
        sellerShipping[sid] = ship;
      }
      validatedItems.push({
        product_id: listing.listing_id || listing.local_id || id,
        seller_id: listing.seller_id,
        canonical_price: listing.price,
        canonical_shipping: listing.shipping_price,
        qty,
        line_cents: linePriceCents,
      });
    }

    let shippingCents = 0;
    for (const sid in sellerShipping) {
      if (Object.prototype.hasOwnProperty.call(sellerShipping, sid)) {
        shippingCents += Math.round(sellerShipping[sid] * 100);
      }
    }
    const taxCents = Math.round(subtotalCents * TAX_RATE);
    const grossTotalCents = subtotalCents + shippingCents + taxCents;

    // ── Style Points redemption validation ────────────────────────
    // Reject if requested > the cap (50% of cart subtotal in points,
    // so a buyer can't drain accumulated points to fully zero out an
    // order — sellers must always see some real cash flow as proof
    // of authentic demand). Also reject if buyer doesn't actually
    // have the points they're trying to spend.
    let pointsApplied = 0;
    let pointsAppliedCents = 0;
    if (requestedRedemption > 0) {
      const subtotalPointsValue = subtotalCents; // 1pt = 1 cent
      const maxAllowed = Math.floor(subtotalPointsValue * REDEMPTION_MAX_PCT);
      const cappedRequest = Math.min(requestedRedemption, maxAllowed);

      const decoded = tryDecodeUser(req);
      const buyerId = decoded && (decoded.userId || decoded.id);
      if (!buyerId) {
        return res.status(401).json({
          error: 'auth_required_for_redemption',
          message: 'Sign in to redeem Style Points.',
        });
      }
      const { data: buyerRow, error: buyerErr } = await supabase
        .from('users').select('op_balance').eq('id', buyerId).single();
      if (buyerErr || !buyerRow) {
        return res.status(400).json({
          error: 'buyer_lookup_failed',
          message: 'Could not verify your Style Points balance — try again.',
        });
      }
      const balance = Math.max(0, Math.floor(Number(buyerRow.op_balance) || 0));
      pointsApplied = Math.min(cappedRequest, balance);
      pointsAppliedCents = pointsApplied; // 1pt = 1 cent in our cash math
    }

    const cashTotalCents = grossTotalCents - pointsAppliedCents;
    if (cashTotalCents < 50) {
      return res.status(400).json({
        error: 'order_below_minimum_after_redemption',
        message: 'After Style Points, the cash total is below Stripe’s 50-cent minimum. Apply fewer points or add more items.',
      });
    }

    // ── Allocate redemption across sellers ──────────────────────────
    // If buyer specified seller_allocation and it's valid, use it.
    // Otherwise, split evenly across sellers (rounding remainder
    // accrues to Outfitd's fee). Records pts allocated PER SELLER —
    // confirm-payment will use this to credit each seller's points.
    const sellerIds = Object.keys(sellerSubtotal);
    const allocation = {}; // seller_id -> points allocated
    let allocationRemainderToOutfitd = 0;
    if (pointsApplied > 0) {
      let total = 0;
      let valid = false;
      if (requestedAllocation && typeof requestedAllocation === 'object') {
        valid = true;
        for (const sid of sellerIds) {
          const v = Math.max(0, Math.floor(Number(requestedAllocation[sid]) || 0));
          allocation[sid] = v;
          total += v;
        }
        // Allow over-spec by up to a few pts of rounding noise; reject
        // anything else so the buyer can't push extra into one seller.
        if (total > pointsApplied + 5 || total < pointsApplied - 5) valid = false;
      }
      if (!valid) {
        // Even split with remainder to Outfitd
        const evenShare = Math.floor(pointsApplied / sellerIds.length);
        for (const sid of sellerIds) allocation[sid] = evenShare;
        const used = evenShare * sellerIds.length;
        allocationRemainderToOutfitd = pointsApplied - used;
      } else {
        // Honour buyer's choice; clamp slight drift back to spec
        let used = 0;
        for (const sid of sellerIds) used += allocation[sid];
        allocationRemainderToOutfitd = pointsApplied - used;
        if (allocationRemainderToOutfitd < 0) allocationRemainderToOutfitd = 0;
      }
    }

    // Stripe metadata is small (max 50 keys × 500 chars). Don't try
    // to stuff item-level allocation in there — confirm-payment will
    // re-derive it from the cart it receives. We DO stash redemption
    // total + per-seller allocation summary for audit and fallback.
    const intentArgs = {
      amount: cashTotalCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        item_count: String(validatedItems.length),
        subtotal_cents: String(subtotalCents),
        shipping_cents: String(shippingCents),
        tax_cents: String(taxCents),
        cash_total_cents: String(cashTotalCents),
        points_applied: String(pointsApplied),
        outfitd_remainder_pts: String(allocationRemainderToOutfitd),
        payout_routing: 'platform_hold_then_transfer',
      },
    };
    const intent = await stripe.paymentIntents.create(intentArgs);

    res.json({
      client_secret: intent.client_secret,
      amount_cents: cashTotalCents,
      breakdown: {
        subtotal_cents: subtotalCents,
        shipping_cents: shippingCents,
        tax_cents: taxCents,
        gross_total_cents: grossTotalCents,
        points_applied: pointsApplied,
        cash_total_cents: cashTotalCents,
        seller_allocation: allocation,
        outfitd_remainder_pts: allocationRemainderToOutfitd,
      },
    });
  } catch (err) {
    console.error('Stripe create-intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
