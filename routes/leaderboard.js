const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid session' });
  }
}

// GET /api/user/subscription
router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('subscription, stripe_customer_id').eq('id', req.user.userId).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    // TODO: verify with Stripe API for production
    res.json({ subscription: user.subscription });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// POST /api/user/check-streak — called on login
router.post('/check-streak', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('login_streak, last_login_date').eq('id', req.user.userId).single();

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    let newStreak = 1;
    if (user.last_login_date === yesterday) newStreak = (user.login_streak || 0) + 1;
    else if (user.last_login_date === today) newStreak = user.login_streak || 1;

    await supabase.from('users')
      .update({ login_streak: newStreak, last_login_date: today })
      .eq('id', req.user.userId);

    // Award streak badges
    const streakBadges = { 7: 'streak_7', 30: 'streak_30', 100: 'streak_100', 365: 'streak_365' };
    const awarded = [];
    for (const [threshold, badge] of Object.entries(streakBadges)) {
      if (newStreak >= parseInt(threshold)) {
        const { error } = await supabase.from('badges').insert({
          user_id: req.user.userId, badge_type: badge
        });
        if (!error) awarded.push(badge);
        // ignore duplicate errors
      }
    }

    res.json({ login_streak: newStreak, new_badges: awarded });
  } catch (err) {
    console.error('Streak error:', err);
    res.status(500).json({ error: 'Streak check failed' });
  }
});

// POST /api/user/referral/apply
router.post('/referral/apply', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Referral code required' });

    // Find referrer
    const { data: referrer } = await supabase
      .from('users').select('id').eq('referral_code', code.toUpperCase()).single();
    if (!referrer) return res.status(404).json({ error: 'Invalid referral code' });
    if (referrer.id === req.user.userId) return res.status(400).json({ error: 'Cannot refer yourself' });

    // Check not already referred
    const { data: existing } = await supabase
      .from('referrals').select('id').eq('referred_id', req.user.userId).limit(1);
    if (existing && existing.length > 0) return res.status(400).json({ error: 'Already used a referral code' });

    // Create referral
    await supabase.from('referrals').insert({
      referrer_id: referrer.id, referred_id: req.user.userId, status: 'completed', reward_paid: true
    });

    // Update user's referred_by
    await supabase.from('users').update({ referred_by: referrer.id }).eq('id', req.user.userId);

    // Award both users 500 OP
    for (const uid of [referrer.id, req.user.userId]) {
      const { data: u } = await supabase.from('users').select('op_balance').eq('id', uid).single();
      await supabase.from('users').update({ op_balance: (u.op_balance || 0) + 500 }).eq('id', uid);
      await supabase.from('transactions').insert({
        user_id: uid, type: 'referral_bonus', currency: 'op_balance',
        amount: 500, description: 'Referral bonus'
      });
    }

    // Check referral badge for referrer
    const { count } = await supabase
      .from('referrals').select('id', { count: 'exact' }).eq('referrer_id', referrer.id);
    if (count >= 3) {
      await supabase.from('badges').insert({ user_id: referrer.id, badge_type: 'referral_3' });
    }

    res.json({ success: true, bonus: 500 });
  } catch (err) {
    console.error('Referral error:', err);
    res.status(500).json({ error: 'Referral failed' });
  }
});

// GET /api/user/badges
router.get('/badges', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('badges').select('badge_type, awarded_at').eq('user_id', req.user.userId);
    if (error) throw error;
    res.json({ badges: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch badges' });
  }
});

// POST /api/user/size-preferences
router.post('/size-preferences', requireAuth, async (req, res) => {
  try {
    const { category, size } = req.body;
    if (!category || !size) return res.status(400).json({ error: 'Category and size required' });

    const { error } = await supabase.from('size_preferences').upsert({
      user_id: req.user.userId, category, size
    }, { onConflict: 'user_id,category' });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save size' });
  }
});

// POST /api/user/price-alert
router.post('/price-alert', requireAuth, async (req, res) => {
  try {
    const { product_brand, product_name, target_price } = req.body;
    const { data, error } = await supabase.from('price_drop_alerts').insert({
      user_id: req.user.userId, product_brand, product_name, target_price
    }).select().single();
    if (error) throw error;
    res.json({ alert: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

module.exports = router;

