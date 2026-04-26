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
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Mirror frontend constants — keep in sync with index.html.
const SHIPPING_FLAT_FEE_DEFAULT = 4;  // fallback when listing has no shipping_price
const TAX_RATE = 0.08;                // 8% on item subtotal only

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
// Body: { items: [{ product_id, qty }], currency?: 'usd' }
// Returns: { client_secret, amount_cents, breakdown: {...} }
// ═══════════════════════════════════════════════════════════════
router.post('/create-intent', async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const currency = (req.body && req.body.currency) || 'usd';
    if (!items.length) {
      return res.status(400).json({ error: 'items required' });
    }

    const productIds = items.map(it => it.product_id || it.id).filter(Boolean);
    const listingMap = await lookupListings(productIds);

    let subtotalCents = 0;
    const sellerShipping = {}; // seller_id -> max shipping_price
    const validatedItems = [];
    for (const item of items) {
      const id = item.product_id || item.id;
      const listing = listingMap[id];
      if (!listing) {
        // Refuse to charge for items we can't price-verify. Better to
        // fail before Stripe than to charge an unknown amount and recover.
        return res.status(400).json({
          error: 'Unknown product in cart — please refresh and try again',
          unknown_product_id: id,
        });
      }
      const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
      const linePriceCents = Math.round(listing.price * 100) * qty;
      subtotalCents += linePriceCents;
      const sid = listing.seller_id || '__unknown__';
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
      });
    }

    let shippingCents = 0;
    for (const sid in sellerShipping) {
      if (Object.prototype.hasOwnProperty.call(sellerShipping, sid)) {
        shippingCents += Math.round(sellerShipping[sid] * 100);
      }
    }
    const taxCents = Math.round(subtotalCents * TAX_RATE);
    const totalCents = subtotalCents + shippingCents + taxCents;
    if (totalCents < 50) {
      return res.status(400).json({ error: 'Order total below Stripe minimum (50 cents)' });
    }

    // ── Stripe Connect payout routing ──────────────────────────
    // If every item is from one seller AND that seller has finished
    // Stripe Connect onboarding, route the charge as a "destination
    // charge": Stripe accepts the buyer's payment, takes our 10%
    // application fee, and the rest lands in the seller's connected
    // account. No manual transfer needed.
    //
    // For multi-seller carts (or sellers who haven't connected yet),
    // we charge to the platform account only; ops reconciles via
    // manual transfers from the Stripe dashboard until we ship a
    // proper Separate-Charges-and-Transfers flow.
    const distinctSellers = new Set(
      validatedItems.map(it => it.seller_id).filter(Boolean)
    );
    const intentArgs = {
      amount: totalCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        item_count: String(validatedItems.length),
        subtotal_cents: String(subtotalCents),
        shipping_cents: String(shippingCents),
        tax_cents: String(taxCents),
      },
    };
    if (distinctSellers.size === 1) {
      const onlySellerId = distinctSellers.values().next().value;
      const { data: sellerRow } = await supabase
        .from('users')
        .select('stripe_account_id')
        .eq('id', onlySellerId)
        .single();
      const sellerStripeId = sellerRow && sellerRow.stripe_account_id;
      if (sellerStripeId) {
        // Application fee = 10% of subtotal (NEVER on shipping or tax).
        // Stripe's API expects the fee in cents.
        const applicationFeeCents = Math.round(subtotalCents * 0.10);
        intentArgs.transfer_data = { destination: sellerStripeId };
        intentArgs.application_fee_amount = applicationFeeCents;
        intentArgs.metadata.payout_routing = 'destination_charge';
        intentArgs.metadata.seller_stripe_id = sellerStripeId;
      } else {
        intentArgs.metadata.payout_routing = 'platform_only_seller_unconnected';
      }
    } else if (distinctSellers.size > 1) {
      intentArgs.metadata.payout_routing = 'platform_only_multi_seller';
    }

    const intent = await stripe.paymentIntents.create(intentArgs);
    res.json({
      client_secret: intent.client_secret,
      amount_cents: totalCents,
      breakdown: {
        subtotal_cents: subtotalCents,
        shipping_cents: shippingCents,
        tax_cents: taxCents,
        total_cents: totalCents,
      },
    });
  } catch (err) {
    console.error('Stripe create-intent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
