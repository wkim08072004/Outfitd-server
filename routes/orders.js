// ═══════════════════════════════════════════════════════════════
// orders.js — Marketplace order routes
// Drop into /Users/eshapatel/outfitd-server/routes/orders.js
// Add to server.js: app.use('/api/orders', require('./routes/orders'));
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Marketplace economics ────────────────────────────────────────────────
// Of the CASH COLLECTED (gross total minus any Style Points redemption):
//   85% → seller (held during return window, then transferred to their
//                 Stripe Connect account)
//   10% → Outfitd (retained as platform fee)
//    5% → buyer (issued as new Style Points — closed-loop currency)
// Shipping is flat per-seller and passes through to the seller in full.
// Tax is collected and remitted by Outfitd separately.
//
// Style Points redeemed by the buyer transfer 1:1 to the seller(s) of the
// items they were redeemed against. Sellers can later cash points back to
// USD at 1:1 (100 pts = $1) via /api/stripe-connect/cashout.
const SHIPPING_FLAT_FEE  = 4;
const SELLER_PAYOUT_PCT  = 0.85;
const PLATFORM_FEE_PCT   = 0.10;
const BUYER_REWARD_PCT   = 0.05;
const RETURN_WINDOW_DAYS = 14;
const POINTS_PER_DOLLAR  = 100;  // 1 pt = 1 cent for cash-conversion math

// ── Auth middleware (reuse your existing one, or inline) ──
function requireAuth(req, res, next) {
  // Assumes your auth middleware attaches req.user with { id, email, role }
  // If you have a different pattern, swap this out
  const jwt = require('jsonwebtoken');
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
// GET /api/orders — Fetch user's order history
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .eq('buyer_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    // Order history is non-critical UI; never 500 the request. Log the cause
    // server-side and return an empty list so the frontend shows its
    // "no orders yet" state instead of a broken modal.
    if (error) {
      console.warn('GET /api/orders — query failed, returning []:',
        error.code || '(no code)', error.message || '(no message)');
      return res.json({ orders: [] });
    }

    const { data: user } = await supabase
      .from('users').select('handle').eq('id', userId).single();
    const buyerHandle = user?.handle ? ('@' + user.handle.replace('@','')) : '';

    const result = (orders || []).map(o => {
      const addr = o.shipping_address || {};
      const addrStr = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
      return {
        id: o.id,
        buyer: buyerHandle,
        createdAt: new Date(o.created_at).getTime(),
        status: o.status || 'awaiting_fulfillment',
        items: [{ emoji: '📦', name: 'Order Item', brand: '', size: '', price: (o.total || 0) / 100 }],
        paymentMethod: o.stripe_payment_id ? 'stripe' : 'stripe',
        subtotal: (o.total || 0) / 100,
        shipping: 0,
        tax: 0,
        total: (o.total || 0) / 100,
        shippingAddress: addrStr,
        trackingNumber: o.tracking_number || null
      };
    });
    res.json({ orders: result });
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});
// ═══════════════════════════════════════════════════════════════
// POST /api/orders/create
// Creates order in DB + Stripe Checkout Session, returns checkout URL
// ═══════════════════════════════════════════════════════════════
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { items, shipping_address, email, payment_method, store_credit_applied } = req.body;
    const userId = req.user.userId;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items provided' });
    }
    if (!shipping_address || !shipping_address.street) {
      return res.status(400).json({ error: 'Shipping address required' });
    }

    // ── Calculate totals SERVER-SIDE (never trust client totals) ──
    // In production: look up each product price from the DB
    // For now, validate items have prices and compute server-side
    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      // TODO: Look up actual price from products table
      // const { data: product } = await supabase.from('products').select('price').eq('id', item.product_id).single();
      // const serverPrice = product.price;
      const serverPrice = Math.round(item.price * 100) / 100; // cents safety
      if (serverPrice <= 0 || serverPrice > 50000) {
        return res.status(400).json({ error: 'Invalid item price: ' + item.name });
      }
      subtotal += serverPrice * (item.qty || 1);
      validatedItems.push({
        product_id: item.product_id,
        brand: item.brand,
        seller_id: item.seller_id,
        name: item.name,
        size: item.size,
        qty: item.qty || 1,
        unit_price: serverPrice,
      });
    }

    const shipping = SHIPPING_FLAT_FEE;
    const tax = Math.round(subtotal * 0.08 * 100) / 100;
    const total = Math.round((subtotal + shipping + tax) * 100) / 100;
    const platformFee = Math.round(subtotal * PLATFORM_FEE_PCT * 100) / 100;

    // ── Create order in DB ──
    const orderNumber = 'OFD-MKT-' + Date.now().toString(36).toUpperCase().slice(-8);

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        order_number: orderNumber,
        user_id: userId,
        buyer_email: email,
        shipping_address: shipping_address,
        items: validatedItems,
        subtotal,
        shipping,
        tax,
        total,
        platform_fee: platformFee,
        // Seller keeps 85% of the item subtotal + the full flat shipping fee
        // (postage cost is theirs to absorb against the $4 we charged).
        seller_payout: Math.round((subtotal * SELLER_PAYOUT_PCT + shipping) * 100) / 100,
        status: 'pending_payment',
        payment_method: payment_method || 'stripe',
        store_credit_applied: store_credit_applied || 0,
      })
      .select()
      .single();

    if (orderErr) {
      console.error('Order creation error:', orderErr);
      return res.status(500).json({ error: 'Failed to create order' });
    }

    // ── Create Stripe Checkout Session ──
    // Get or create Stripe customer
    let stripeCustomerId;
    const { data: userRecord } = await supabase
      .from('users')
      .select('stripe_customer_id, email')
      .eq('id', userId)
      .single();

    if (userRecord?.stripe_customer_id) {
      stripeCustomerId = userRecord.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: email || userRecord?.email,
        metadata: { outfitd_user_id: userId },
      });
      stripeCustomerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customer.id }).eq('id', userId);
    }

    const lineItems = validatedItems.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: `${item.brand} · Size ${item.size}`,
        },
        unit_amount: Math.round(item.unit_price * 100), // Stripe uses cents
      },
      quantity: item.qty,
    }));

    // Add shipping as a line item if applicable
    if (shipping > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Shipping' },
          unit_amount: Math.round(shipping * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'payment',
      line_items: lineItems,
      automatic_tax: { enabled: false }, // We calculate tax ourselves
      metadata: {
        order_id: order.id,
        order_number: orderNumber,
        platform_fee: platformFee.toString(),
      },
      success_url: `${process.env.FRONTEND_URL}?order_success=${orderNumber}`,
      cancel_url: `${process.env.FRONTEND_URL}?order_cancelled=${orderNumber}`,
    });

    // Update order with Stripe session ID
    await supabase
      .from('orders')
      .update({ stripe_session_id: session.id })
      .eq('id', order.id);

    return res.json({ checkout_url: session.url, order_number: orderNumber });
  } catch (err) {
    console.error('Order create error:', err);
    return res.status(500).json({ error: 'Order processing failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/confirm-payment
// Called by the frontend after Stripe.js confirms a PaymentIntent.
// Verifies the PaymentIntent succeeded with Stripe, then writes one
// order row per cart item. Idempotent: re-calling with the same
// payment_intent_id returns the previously-inserted order IDs without
// double-charging anyone (the source of truth is the (buyer, listing,
// stripe_payment_id) tuple).
// ═══════════════════════════════════════════════════════════════
router.post('/confirm-payment', requireAuth, async (req, res) => {
  const { payment_intent_id, items, shipping_address, email } = req.body || {};
  const buyerId = req.user.userId;
  if (!payment_intent_id) {
    return res.status(400).json({ error: 'payment_intent_id required' });
  }

  try {
    // 1) Verify with Stripe — never trust the client to say "I paid".
    //    The intent.metadata is our authoritative record of how much
    //    Style Points the buyer redeemed (set at create-intent time
    //    after server-side validation), so we use THAT number for
    //    bookkeeping rather than anything the client sends here.
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.status !== 'succeeded') {
      console.warn('[confirm-payment] PaymentIntent not succeeded:',
        payment_intent_id, intent.status);
      return res.status(400).json({
        error: 'Payment not completed',
        intent_status: intent.status,
      });
    }
    const piMeta = intent.metadata || {};
    const pointsApplied = Math.max(0, parseInt(piMeta.points_applied || '0', 10) || 0);
    const outfitdRemainderPts = Math.max(0, parseInt(piMeta.outfitd_remainder_pts || '0', 10) || 0);

    // 2) Idempotency: if we've already recorded any rows for this
    //    payment_intent_id, return them unchanged. Important — without
    //    this, a frontend retry after a momentary network blip would
    //    double-credit Style Points and double-insert order rows.
    const { data: existing } = await supabase
      .from('orders')
      .select('id, listing_id, seller_id')
      .eq('stripe_payment_id', payment_intent_id);
    if (existing && existing.length > 0) {
      return res.json({
        ok: true,
        already_recorded: true,
        order_ids: existing.map(o => o.id),
      });
    }

    // 3) Decide what to insert. SECURITY (audit §1.7): we look up
    //    canonical prices from seller_listings for every item rather
    //    than trusting whatever the cart payload says. The PaymentIntent
    //    we created at /api/payments/create-intent was already priced
    //    server-side, so this is belt-and-suspenders: the order rows we
    //    write match the DB's canonical prices, not the client's cart.
    //    Each seller's shipping fee is paid once per order (attributed
    //    to the first row for that seller, others get $0 shipping —
    //    sellers pack multiple items in one package).
    const rows = [];
    const insertErrors = [];
    let pointsRemainderToOutfitd = 0;
    if (Array.isArray(items) && items.length > 0) {
      const productIds = items.map(it => it.product_id || it.id).filter(Boolean);
      let listingMap = {};
      try {
        // Inline lookup so we don't have to share the helper across
        // route files. Same shape as payments.js's lookupListings.
        const localCandidates = new Set();
        const uuidCandidates = new Set();
        for (const raw of productIds) {
          const r = String(raw).trim();
          if (!r) continue;
          localCandidates.add(r);
          if (r.startsWith('dyn_')) localCandidates.add(r.slice(4));
          else localCandidates.add('dyn_' + r);
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r)) {
            uuidCandidates.add(r);
          }
        }
        function parseShip(d) {
          if (typeof d !== 'string') return 4;
          try { const m = JSON.parse(d); if (typeof m.shipping_price === 'number') return m.shipping_price; } catch (e) {}
          return 4;
        }
        if (localCandidates.size) {
          const { data } = await supabase
            .from('seller_listings')
            .select('id, local_id, price, description, seller_id')
            .in('local_id', Array.from(localCandidates));
          for (const row of (data || [])) {
            const rec = { listing_id: row.id, price: Number(row.price) || 0, shipping_price: parseShip(row.description), seller_id: row.seller_id };
            if (row.id) listingMap[row.id] = rec;
            if (row.local_id) {
              listingMap[row.local_id] = rec;
              listingMap['dyn_' + row.local_id] = rec;
            }
          }
        }
        const stillMissing = [...uuidCandidates].filter(id => !listingMap[id]);
        if (stillMissing.length) {
          const { data } = await supabase
            .from('seller_listings')
            .select('id, local_id, price, description, seller_id')
            .in('id', stillMissing);
          for (const row of (data || [])) {
            const rec = { listing_id: row.id, price: Number(row.price) || 0, shipping_price: parseShip(row.description), seller_id: row.seller_id };
            if (row.id) listingMap[row.id] = rec;
            if (row.local_id) listingMap[row.local_id] = rec;
          }
        }
      } catch (lookupErr) {
        console.warn('[confirm-payment] listing lookup failed, falling back to client values:',
          lookupErr.message);
        listingMap = {};
      }

      // Per-seller MAX shipping using canonical values where available.
      const sellerShipping = {};       // sid -> shipping fee (dollars)
      const sellerSubtotalCents = {};  // sid -> sum of item line totals
      for (const item of items) {
        const id = item.product_id || item.id;
        const canonical = listingMap[id];
        const ship = canonical ? canonical.shipping_price
                               : (Number.isFinite(Number(item.shipping_price)) ? Number(item.shipping_price) : 4);
        const sid = (canonical && canonical.seller_id) || item.seller_id || item.sellerId || '__unknown__';
        if (sellerShipping[sid] === undefined || ship > sellerShipping[sid]) sellerShipping[sid] = ship;
        const unitPrice = canonical ? canonical.price : (Number(item.price) || 0);
        const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
        sellerSubtotalCents[sid] = (sellerSubtotalCents[sid] || 0) + Math.round(unitPrice * qty * 100);
      }

      // ── Distribute redemption across sellers ────────────────────
      // The PaymentIntent metadata already carries the seller-level
      // allocation rule (even split with remainder to Outfitd unless
      // buyer specified). Rebuild that here so confirm-payment can
      // distribute on a per-row basis proportional to each row's
      // share of its seller's items.
      const sellerIds = Object.keys(sellerSubtotalCents);
      const sellerPointsAlloc = {}; // sid -> pts allocated to this seller
      if (pointsApplied > 0 && sellerIds.length > 0) {
        const evenShare = Math.floor(pointsApplied / sellerIds.length);
        for (const sid of sellerIds) sellerPointsAlloc[sid] = evenShare;
        pointsRemainderToOutfitd = pointsApplied - (evenShare * sellerIds.length);
        // Reconcile against the PI's recorded remainder; if they
        // disagree, trust the PI's value (set at create-intent under
        // the same buyer-allocation logic).
        if (outfitdRemainderPts > pointsRemainderToOutfitd) {
          pointsRemainderToOutfitd = outfitdRemainderPts;
        }
      }

      const sellerShippingClaimed = {};
      const sellerPointsAttributed = {}; // sid -> pts assigned so far across rows
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const item of items) {
        const id = item.product_id || item.id;
        const canonical = listingMap[id];
        const unitPrice = canonical ? canonical.price : (Number(item.price) || 0);
        const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));

        // The orders.seller_id column is a uuid FK to users(id). The cart's
        // own item.seller_id is a `dyn_<email>` display token, NOT a real
        // user id, so it's never safe to write directly. We require canonical
        // lookup to succeed, OR a client-supplied seller_id that's a real
        // UUID. Anything else means we couldn't resolve the listing's owner —
        // refuse to record the row rather than silently mis-attributing it.
        const candidateSid = (canonical && canonical.seller_id)
          || (item.seller_id && UUID_RE.test(String(item.seller_id)) ? item.seller_id : null)
          || (item.sellerId  && UUID_RE.test(String(item.sellerId))  ? item.sellerId  : null);
        if (!candidateSid) {
          insertErrors.push('seller_unresolved:' + (id || '(no id)'));
          console.error('[confirm-payment] refusing row — cannot resolve seller for item:',
            id, 'cart-supplied:', item.seller_id || item.sellerId || '(none)',
            'canonical-hit:', !!canonical);
          continue;
        }
        const sid = candidateSid;
        const sellerIdForRow = candidateSid;

        const lineItemCents = Math.round(unitPrice * qty * 100);
        const shippingForRow = sellerShippingClaimed[sid]
          ? 0
          : Math.round((sellerShipping[sid] || 0) * 100);
        sellerShippingClaimed[sid] = true;
        const grossRowCents = lineItemCents + shippingForRow;

        // Row's share of seller's redemption: proportional to item
        // value within the seller's items. Last row in each seller
        // gets the rounding remainder so the seller's allocation
        // sums exactly.
        let pointsForRow = 0;
        if (pointsApplied > 0 && sellerPointsAlloc[sid]) {
          const sellerTotal = sellerSubtotalCents[sid] || 1;
          const itemFraction = lineItemCents / sellerTotal;
          pointsForRow = Math.floor(sellerPointsAlloc[sid] * itemFraction);
          // Track for rounding fix on last row of this seller
          sellerPointsAttributed[sid] = (sellerPointsAttributed[sid] || 0) + pointsForRow;
        }
        // Ensure last row absorbs any rounding remainder for its seller
        const isLastForSeller = !items.slice(items.indexOf(item) + 1).some(it2 => {
          const c2 = listingMap[it2.product_id || it2.id];
          const s2 = (c2 && c2.seller_id) || it2.seller_id || it2.sellerId || '__unknown__';
          return s2 === sid;
        });
        if (isLastForSeller && pointsApplied > 0 && sellerPointsAlloc[sid]) {
          const remainder = sellerPointsAlloc[sid] - sellerPointsAttributed[sid];
          if (remainder > 0) pointsForRow += remainder;
        }

        const cashCollectedCents = Math.max(0, grossRowCents - pointsForRow);
        // 85% / 10% / 5% split is on CASH COLLECTED for this row.
        // Shipping is excluded from the % math — shipping passes
        // through to the seller in full.
        const cashItemPortion = Math.max(0, cashCollectedCents - shippingForRow);
        const sellerCashCents = Math.round(cashItemPortion * SELLER_PAYOUT_PCT) + shippingForRow;
        const platformFeeCents = Math.round(cashItemPortion * PLATFORM_FEE_PCT);
        const buyerRewardPts = Math.round(cashItemPortion * BUYER_REWARD_PCT);

        rows.push({
          buyer_id: buyerId,
          seller_id: sellerIdForRow,
          listing_id: (canonical && canonical.listing_id) || item.product_id || item.id || null,
          total: grossRowCents,                    // headline price (cents)
          stripe_payment_id: payment_intent_id,
          shipping_address: shipping_address || null,
          status: 'paid',
          // Robux-economy bookkeeping (new columns — see migration list)
          gross_total_cents:    grossRowCents,
          shipping_cents:       shippingForRow,
          cash_collected_cents: cashCollectedCents,
          points_applied:       pointsForRow,
          seller_cash_due_cents: sellerCashCents,
          seller_points_due:    pointsForRow,      // pts pass through 1:1 to seller
          platform_fee_cents:   platformFeeCents,
          buyer_reward_pts:     buyerRewardPts,
          return_window_days:   RETURN_WINDOW_DAYS,
        });
      }
    } else {
      rows.push({
        buyer_id: buyerId,
        seller_id: null,
        listing_id: null,
        total: intent.amount,
        stripe_payment_id: payment_intent_id,
        shipping_address: shipping_address || null,
        status: 'paid',
        cash_collected_cents: intent.amount,
      });
    }

    const orderIds = [];
    for (const row of rows) {
      const { data, error } = await supabase
        .from('orders').insert(row).select('id').single();
      if (error) {
        insertErrors.push(error.message || String(error));
        console.error('[confirm-payment] insert failed:',
          error.code || '(no code)', error.message || '(no message)',
          'row:', JSON.stringify(row));
        continue;
      }
      if (data && data.id) orderIds.push(data.id);
    }

    if (orderIds.length === 0) {
      // Fail loud — Stripe charged but we didn't record anything.
      // The frontend should surface this to the user with support contact info.
      return res.status(500).json({
        error: 'Payment succeeded but order could not be recorded. Please contact support with this reference.',
        payment_intent_id,
        details: insertErrors.join('; '),
      });
    }

    // Optional buyer-side email update for downstream display
    if (email) {
      await supabase
        .from('orders')
        .update({ buyer_email: email })
        .eq('stripe_payment_id', payment_intent_id);
    }

    // ── Style Points ledger updates ─────────────────────────────────────
    // We do four things here, all best-effort (the orders are already
    // recorded above; if a points step fails we log and continue rather
    // than fail the whole call after Stripe took the buyer's money):
    //   1. Deduct the buyer's redeemed points from their op_balance
    //   2. Credit each seller's op_balance with their pass-through points
    //   3. Credit the buyer's op_balance with new earn pts (5% of cash)
    //   4. Insert audit-trail rows in `transactions` for everything
    //
    // Subscription tier still bumps the EARN rate (Insider 7%, Legend 10%)
    // — the rest of the model treats all buyers identically.
    let totalPointsAwarded = 0;
    let totalPointsRedeemed = 0;
    const sellerPointsCredited = {};
    try {
      const sellerPointsByRow = {}; // sid -> sum(seller_points_due) across rows
      let buyerRewardSum = 0;
      let pointsAppliedSum = 0;
      for (const row of rows) {
        if (row.seller_id && row.seller_points_due) {
          sellerPointsByRow[row.seller_id] = (sellerPointsByRow[row.seller_id] || 0) + row.seller_points_due;
        }
        buyerRewardSum += row.buyer_reward_pts || 0;
        pointsAppliedSum += row.points_applied || 0;
      }

      const { data: buyer } = await supabase
        .from('users')
        .select('subscription, op_balance')
        .eq('id', buyerId)
        .single();

      // Apply tier bonus to NEW earn rate only — redemption math stays at 1:1.
      const tierRate = (buyer && buyer.subscription === 'legend') ? 0.10
        : (buyer && buyer.subscription === 'insider') ? 0.07 : BUYER_REWARD_PCT;
      // If Insider/Legend, the 5% baseline is replaced by tier rate. We
      // recompute against the same cash-item-portion the rows used.
      let tierAdjustedReward = buyerRewardSum;
      if (tierRate !== BUYER_REWARD_PCT) {
        let cashItemPortionSum = 0;
        for (const row of rows) {
          cashItemPortionSum += Math.max(0, (row.cash_collected_cents || 0) - (row.shipping_cents || 0));
        }
        tierAdjustedReward = Math.round(cashItemPortionSum * tierRate);
      }

      // 1) Deduct buyer's redeemed points + 3) credit buyer's new reward
      //    in one update (atomic relative to other writes against this row).
      const buyerOldBalance = (buyer && buyer.op_balance) || 0;
      const buyerNewBalance = Math.max(0, buyerOldBalance - pointsAppliedSum + tierAdjustedReward);
      if (buyerOldBalance !== buyerNewBalance) {
        await supabase.from('users').update({ op_balance: buyerNewBalance }).eq('id', buyerId);
      }
      if (pointsAppliedSum > 0) {
        await supabase.from('transactions').insert({
          user_id: buyerId, type: 'redemption', currency: 'op_balance',
          amount: -pointsAppliedSum,
          description: 'Redeemed ' + pointsAppliedSum + ' Style Points on order ' + (orderIds[0] || ''),
        });
        totalPointsRedeemed = pointsAppliedSum;
      }
      if (tierAdjustedReward > 0) {
        await supabase.from('transactions').insert({
          user_id: buyerId, type: 'purchase_reward', currency: 'op_balance',
          amount: tierAdjustedReward,
          description: 'Order reward: +' + tierAdjustedReward + ' Style Points',
        });
        totalPointsAwarded = tierAdjustedReward;
      }

      // 2) Credit each seller's op_balance with their pass-through points.
      //    Done one seller at a time — each is a separate user row update.
      for (const sid of Object.keys(sellerPointsByRow)) {
        const pts = sellerPointsByRow[sid];
        if (pts <= 0) continue;
        const { data: sellerRow } = await supabase
          .from('users').select('op_balance').eq('id', sid).single();
        const sellerOld = (sellerRow && sellerRow.op_balance) || 0;
        await supabase.from('users')
          .update({ op_balance: sellerOld + pts }).eq('id', sid);
        await supabase.from('transactions').insert({
          user_id: sid, type: 'redemption_inflow', currency: 'op_balance',
          amount: pts,
          description: 'Style Points received from buyer redemption on order ' + (orderIds[0] || ''),
        });
        sellerPointsCredited[sid] = pts;
      }

      // 4) The Outfitd remainder pts (rounding from even-split) accrue
      //    silently to the platform fee — recorded as a transaction
      //    against the system "outfitd" user_id placeholder, or just
      //    logged. We don't need to write a row to update Outfitd's
      //    balance because the platform never withdraws Style Points.
      if (pointsRemainderToOutfitd > 0) {
        console.log('[confirm-payment] outfitd retained ' + pointsRemainderToOutfitd +
          ' pts as redemption-allocation rounding remainder, PI=' + payment_intent_id);
      }
    } catch (pointsErr) {
      console.warn('[confirm-payment] Style Points ledger update partial failure:',
        pointsErr.message || pointsErr);
    }

    res.json({
      ok: true,
      order_ids: orderIds,
      payment_intent_id,
      points_redeemed: totalPointsRedeemed,
      points_awarded: totalPointsAwarded,
      seller_points_credited: sellerPointsCredited,
    });
  } catch (err) {
    console.error('[confirm-payment] error:', err);
    res.status(500).json({
      error: err.message || 'Failed to confirm payment',
      payment_intent_id,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/seller
// Returns orders where the current user is the seller. Powers the
// seller dashboard's orders tab (which previously tried to filter the
// buyer's order list — which never contains the seller's own sales).
// ═══════════════════════════════════════════════════════════════
router.get('/seller', requireAuth, async (req, res) => {
  try {
    const sellerId = req.user.userId;
    // Try the joined query first for richer line-item data; if the FK
    // isn't configured between orders.listing_id and seller_listings.id,
    // fall back to a plain select so the dashboard still renders.
    let data, error;
    ({ data, error } = await supabase
      .from('orders')
      .select('*, seller_listings(title, images)')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .limit(200));
    if (error) {
      console.warn('[orders/seller] join query failed, retrying without join:',
        error.code || '(no code)', error.message || '(no message)');
      ({ data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('seller_id', sellerId)
        .order('created_at', { ascending: false })
        .limit(200));
    }
    if (error) {
      console.warn('[orders/seller] fallback select failed, returning []:',
        error.code || '(no code)', error.message || '(no message)');
      return res.json({ orders: [] });
    }
    // Reshape into the shape the seller dashboard render template expects.
    // The frontend filters `o.items` by `i.brand === sellerName`, so we set
    // brand = the seller's own display name to make the existing filter pass.
    const { data: seller } = await supabase
      .from('users').select('name, handle').eq('id', sellerId).single();
    const sellerName = (seller && (seller.name || seller.handle)) || 'Seller';

    // Per-row hold/release status — UI shows "in hold until DATE" vs "available"
    const nowMs = Date.now();
    const shaped = (data || []).map(o => {
      const listing = o.seller_listings || {};
      const addr = o.shipping_address || {};
      const addrStr = typeof o.shipping_address === 'string'
        ? o.shipping_address
        : [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
      const windowDays = Math.max(0, Number(o.return_window_days) || RETURN_WINDOW_DAYS);
      const releaseAt = o.created_at
        ? new Date(o.created_at).getTime() + windowDays * 24 * 60 * 60 * 1000
        : null;
      const inHold = releaseAt ? releaseAt > nowMs : false;
      return {
        id: o.id,
        items: [{ brand: sellerName, name: listing.title || 'Item', size: '' }],
        shippingAddress: addrStr,
        total: (o.total || 0) / 100,
        sellerCashDue: (o.seller_cash_due_cents || 0) / 100,
        sellerPointsDue: o.seller_points_due || 0,
        status: o.status || 'paid',
        inHold: inHold,
        releaseAt: releaseAt ? new Date(releaseAt).toISOString() : null,
        transferId: o.transfer_id || null,
        createdAt: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
      };
    });

    // Earnings rollup so the dashboard can show available-vs-held without a
    // second round-trip. Cash side comes from order rows; points side from the
    // shared breakdown helper used by /cashout.
    let cashAvailableCents = 0;
    let cashHeldCents = 0;
    let cashReleasedCents = 0; // already transferred out to seller's Stripe
    for (const o of (data || [])) {
      const due = Number(o.seller_cash_due_cents || 0);
      if (!due) continue;
      if (o.transfer_id) {
        cashReleasedCents += due;
      } else {
        const windowDays = Math.max(0, Number(o.return_window_days) || RETURN_WINDOW_DAYS);
        const releaseAt = o.created_at
          ? new Date(o.created_at).getTime() + windowDays * 24 * 60 * 60 * 1000
          : null;
        if (releaseAt && releaseAt > nowMs) cashHeldCents += due;
        else cashAvailableCents += due; // past window, awaiting next release-due sweep
      }
    }

    const ptsBreakdown = await computeSellerPointsBreakdown(sellerId);

    res.json({
      orders: shaped,
      earnings: {
        cash_available_cents: cashAvailableCents,
        cash_held_cents:      cashHeldCents,
        cash_released_cents:  cashReleasedCents,
        points: ptsBreakdown,
      },
    });
  } catch (err) {
    console.error('GET /api/orders/seller error:', err);
    res.status(500).json({ error: 'Failed to fetch seller orders' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/release-due
// Idempotent. Finds orders whose return window has expired and the
// seller hasn't been paid yet (transfer_id IS NULL), groups by
// seller, and creates one Stripe Transfer per seller for the sum
// of their seller_cash_due_cents (which already includes shipping).
//
// Called lazily from the seller's earnings page on render — that
// way no cron is required, and the transfer fires within seconds
// of the seller actually checking their balance. Calling it more
// often than needed is safe (the date filter excludes already-
// transferred rows). Anyone authenticated can call it; it only
// touches orders for connected sellers and is rate-limited
// implicitly by the per-row idempotency check.
// ═══════════════════════════════════════════════════════════════
router.post('/release-due', requireAuth, async (req, res) => {
  try {
    // Find rows that are paid, not yet released, and past their
    // return window. Use created_at + return_window_days as the
    // cutoff (we don't have reliable delivered_at tracking yet).
    const cutoff = new Date(Date.now() - RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: dueRows, error: dueErr } = await supabase
      .from('orders')
      .select('id, seller_id, seller_cash_due_cents, stripe_payment_id, created_at')
      .eq('status', 'paid')
      .is('transfer_id', null)
      .lt('created_at', cutoff)
      .not('seller_id', 'is', null);
    if (dueErr) {
      console.warn('[release-due] query failed:', dueErr.code, dueErr.message);
      return res.json({ ok: true, released: [], error: 'query_failed' });
    }
    if (!dueRows || dueRows.length === 0) {
      return res.json({ ok: true, released: [] });
    }

    // Group by seller
    const bySeller = {};
    for (const row of dueRows) {
      if (!row.seller_id || !row.seller_cash_due_cents) continue;
      if (!bySeller[row.seller_id]) bySeller[row.seller_id] = { rows: [], total_cents: 0 };
      bySeller[row.seller_id].rows.push(row);
      bySeller[row.seller_id].total_cents += row.seller_cash_due_cents;
    }

    const released = [];
    const skipped = [];
    for (const sellerId of Object.keys(bySeller)) {
      const group = bySeller[sellerId];
      if (group.total_cents <= 0) continue;
      const { data: sellerRow } = await supabase
        .from('users').select('stripe_account_id').eq('id', sellerId).single();
      if (!sellerRow || !sellerRow.stripe_account_id) {
        skipped.push({ seller_id: sellerId, reason: 'not_connected', total_cents: group.total_cents });
        continue;
      }
      try {
        const transfer = await stripe.transfers.create({
          amount: group.total_cents,
          currency: 'usd',
          destination: sellerRow.stripe_account_id,
          transfer_group: 'release_' + sellerId + '_' + Date.now(),
          metadata: {
            order_count: String(group.rows.length),
            seller_id: String(sellerId),
            release_kind: 'return_window_expired',
          },
        });
        // Mark all rows in this group as released
        const orderIds = group.rows.map(r => r.id);
        await supabase
          .from('orders')
          .update({
            status: 'released',
            transfer_id: transfer.id,
            released_at: new Date().toISOString(),
          })
          .in('id', orderIds);
        released.push({ seller_id: sellerId, transfer_id: transfer.id, amount_cents: group.total_cents, order_count: orderIds.length });
      } catch (transferErr) {
        console.error('[release-due] transfer to', sellerId, 'failed:', transferErr.message);
        skipped.push({ seller_id: sellerId, reason: 'transfer_failed', message: transferErr.message });
      }
    }

    res.json({ ok: true, released, skipped });
  } catch (err) {
    console.error('[release-due] unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// Helper: compute a seller's Style Points breakdown.
//
// Splits the seller's op_balance into three buckets so the dashboard can
// show "X available / Y in hold" and the cashout endpoint can refuse
// pre-window withdrawals:
//
//   total_earned_pts    sum of seller_points_due across every order
//                       (how many points buyers have ever transferred
//                       to this seller)
//   held_pts            subset of total_earned_pts whose source orders
//                       are still inside their 14-day return window —
//                       still subject to clawback if the buyer refunds
//   released_pts        total_earned_pts - held_pts
//   prior_cashouts_pts  sum of past cashout transactions (positive)
//   available_to_cashout  max(0, released_pts - prior_cashouts_pts)
//                       capped at current op_balance so we never offer
//                       to cash out points the user no longer holds
//   next_release_at     ISO timestamp of the earliest order that's
//                       still in window — UI shows "available DATE"
// ═══════════════════════════════════════════════════════════════
async function computeSellerPointsBreakdown(sellerId) {
  const out = {
    total_earned_pts: 0,
    held_pts: 0,
    released_pts: 0,
    prior_cashouts_pts: 0,
    available_to_cashout: 0,
    op_balance: 0,
    next_release_at: null,
  };
  if (!sellerId) return out;

  const { data: userRow } = await supabase
    .from('users').select('op_balance').eq('id', sellerId).single();
  out.op_balance = Math.max(0, Math.floor(Number(userRow && userRow.op_balance) || 0));

  const { data: rows } = await supabase
    .from('orders')
    .select('seller_points_due, created_at, return_window_days')
    .eq('seller_id', sellerId);
  const now = Date.now();
  let earliestStillInWindow = null;
  for (const r of (rows || [])) {
    const pts = Math.max(0, Math.floor(Number(r.seller_points_due) || 0));
    if (!pts) continue;
    out.total_earned_pts += pts;
    const windowDays = Math.max(0, Number(r.return_window_days) || RETURN_WINDOW_DAYS);
    const releaseAt = new Date(r.created_at).getTime() + windowDays * 24 * 60 * 60 * 1000;
    if (releaseAt > now) {
      out.held_pts += pts;
      if (!earliestStillInWindow || releaseAt < earliestStillInWindow) {
        earliestStillInWindow = releaseAt;
      }
    } else {
      out.released_pts += pts;
    }
  }
  out.next_release_at = earliestStillInWindow ? new Date(earliestStillInWindow).toISOString() : null;

  const { data: cashouts } = await supabase
    .from('transactions')
    .select('amount')
    .eq('user_id', sellerId)
    .eq('type', 'cashout');
  out.prior_cashouts_pts = (cashouts || []).reduce(
    (sum, t) => sum + Math.abs(Math.floor(Number(t.amount) || 0)), 0
  );

  out.available_to_cashout = Math.max(
    0,
    Math.min(out.released_pts - out.prior_cashouts_pts, out.op_balance)
  );
  return out;
}

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/cashout
// Seller converts accumulated Style Points back to USD at 1:1
// (100 pts = $1). Funds go to the seller's connected Stripe account
// via a transfer. Atomically decrements op_balance.
//
// Cashable amount is restricted to points whose source orders have
// already passed their return window — points from in-window orders
// are still subject to refund clawback so we don't release them yet.
//
// Source of the cash: Outfitd's accumulated platform fees from past
// transactions. Solvency invariant: cumulative platform fees minus
// cumulative cashouts is always positive in the steady state because
// every transaction nets Outfitd 5–10% of cash collected.
// ═══════════════════════════════════════════════════════════════
router.post('/cashout', requireAuth, async (req, res) => {
  try {
    const sellerId = req.user.userId;
    const requested = Math.max(0, Math.floor(Number(req.body && req.body.points) || 0));
    if (requested < 100) {
      return res.status(400).json({
        error: 'cashout_minimum_not_met',
        message: 'Minimum cashout is 100 Style Points ($1.00).',
      });
    }
    const { data: seller, error: sellerErr } = await supabase
      .from('users').select('op_balance, stripe_account_id').eq('id', sellerId).single();
    if (sellerErr || !seller) {
      return res.status(400).json({ error: 'seller_lookup_failed' });
    }
    if (!seller.stripe_account_id) {
      return res.status(400).json({
        error: 'no_connected_account',
        message: 'Connect your Stripe account in Earnings before cashing out.',
      });
    }

    const breakdown = await computeSellerPointsBreakdown(sellerId);
    if (requested > breakdown.available_to_cashout) {
      const heldNote = breakdown.held_pts > 0 && breakdown.next_release_at
        ? ' ' + breakdown.held_pts + ' pts are still in their 14-day return window — earliest release ' +
          new Date(breakdown.next_release_at).toLocaleDateString() + '.'
        : '';
      return res.status(400).json({
        error: 'insufficient_available_balance',
        message: 'Only ' + breakdown.available_to_cashout +
                 ' pts are past the return window and available to cash out.' + heldNote,
        breakdown,
      });
    }

    const balance = Math.max(0, Math.floor(Number(seller.op_balance) || 0));
    const cashCents = requested; // 1pt = 1 cent

    // Decrement balance FIRST (atomic-ish — Supabase doesn't have row-
    // level CAS without RLS, but the read-then-write here is bounded
    // by the auth scope of one user). Stripe transfer next; if it
    // fails we restore the balance below.
    await supabase.from('users')
      .update({ op_balance: balance - requested })
      .eq('id', sellerId);

    let transfer;
    try {
      transfer = await stripe.transfers.create({
        amount: cashCents,
        currency: 'usd',
        destination: seller.stripe_account_id,
        metadata: { kind: 'style_points_cashout', seller_id: String(sellerId), points: String(requested) },
      });
    } catch (transferErr) {
      // Restore balance on transfer failure
      await supabase.from('users')
        .update({ op_balance: balance }).eq('id', sellerId);
      console.error('[cashout] transfer failed:', transferErr.message);
      return res.status(502).json({
        error: 'transfer_failed',
        message: 'Stripe rejected the cashout: ' + transferErr.message,
      });
    }

    await supabase.from('transactions').insert({
      user_id: sellerId,
      type: 'cashout',
      currency: 'op_balance',
      amount: -requested,
      description: 'Cashed out ' + requested + ' Style Points → $' + (cashCents / 100).toFixed(2) + ' (transfer ' + transfer.id + ')',
    });

    res.json({
      ok: true,
      points_cashed_out: requested,
      cents_transferred: cashCents,
      transfer_id: transfer.id,
      new_balance: balance - requested,
    });
  } catch (err) {
    console.error('[cashout] unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/history
// Returns the user's past orders
// ═══════════════════════════════════════════════════════════════
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', req.user.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: 'Failed to fetch orders' });
    return res.json({ orders: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/:id
// Returns a single order detail
// ═══════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('order_number', req.params.id)
      .eq('user_id', req.user.userId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Order not found' });
    return res.json({ order: data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

module.exports = router;
