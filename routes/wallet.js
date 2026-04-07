const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');

// Middleware: require auth
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

// GET /api/wallet/balance
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('op_balance, cash_balance, store_credits')
      .eq('id', req.user.userId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// POST /api/wallet/award — server awards currency after verified action
router.post('/award', requireAuth, async (req, res) => {
  try {
    const { currency, amount, description, reference_id } = req.body;

    if (!currency || !amount || amount <= 0)
      return res.status(400).json({ error: 'Invalid currency or amount' });

    const validCurrencies = ['op_balance', 'cash_balance', 'store_credits'];
    if (!validCurrencies.includes(currency))
      return res.status(400).json({ error: 'Invalid currency type' });

    // Get current balance
    const { data: user } = await supabase
      .from('users')
      .select(currency)
      .eq('id', req.user.userId)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const newBalance = (user[currency] || 0) + amount;

    // Update balance
    await supabase
      .from('users')
      .update({ [currency]: newBalance })
      .eq('id', req.user.userId);

    // Log transaction
    await supabase.from('transactions').insert({
      user_id: req.user.userId,
      type: 'award',
      currency,
      amount,
      description: description || '',
      reference_id: reference_id || null
    });

    res.json({ [currency]: newBalance });
  } catch (err) {
    console.error('Award error:', err);
    res.status(500).json({ error: 'Award failed' });
  }
});

// POST /api/wallet/deduct — deduct currency (for wagers, purchases)
router.post('/deduct', requireAuth, async (req, res) => {
  try {
    const { currency, amount, description, reference_id } = req.body;

    if (!currency || !amount || amount <= 0)
      return res.status(400).json({ error: 'Invalid currency or amount' });

    const validCurrencies = ['op_balance', 'cash_balance', 'store_credits'];
    if (!validCurrencies.includes(currency))
      return res.status(400).json({ error: 'Invalid currency type' });

    // Get current balance
    const { data: user } = await supabase
      .from('users')
      .select(currency)
      .eq('id', req.user.userId)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });
    if ((user[currency] || 0) < amount)
      return res.status(400).json({ error: 'Insufficient balance' });

    const newBalance = user[currency] - amount;

    await supabase
      .from('users')
      .update({ [currency]: newBalance })
      .eq('id', req.user.userId);

    await supabase.from('transactions').insert({
      user_id: req.user.userId,
      type: 'deduct',
      currency,
      amount: -amount,
      description: description || '',
      reference_id: reference_id || null
    });

    res.json({ [currency]: newBalance });
  } catch (err) {
    console.error('Deduct error:', err);
    res.status(500).json({ error: 'Deduct failed' });
  }
});

// POST /api/wallet/redeem — convert Style Points to Store Credits (100:1)
router.post('/redeem', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const { data: user } = await supabase
      .from('users')
      .select('op_balance, store_credits, subscription')
      .eq('id', req.user.userId)
      .single();

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.op_balance < amount) return res.status(400).json({ error: 'Insufficient Style Points' });

    // Min redeem by tier
    const tier = user.subscription || 'free';
    const minRedeem = tier === 'legend' ? 2500 : tier === 'insider' ? 5000 : 10000;
    if (amount < minRedeem) return res.status(400).json({ error: 'Minimum ' + minRedeem + ' Style Points required' });

    // 100 Style Points = $1.00
    const dollarValue = Math.round((amount / 100) * 100) / 100;
    const newOP = user.op_balance - amount;
    const newCredits = (user.store_credits || 0) + dollarValue;

    await supabase
      .from('users')
      .update({ op_balance: newOP, store_credits: newCredits })
      .eq('id', req.user.userId);

    await supabase.from('transactions').insert({
      user_id: req.user.userId,
      type: 'redeem',
      currency: 'store_credits',
      amount: dollarValue,
      description: 'Redeemed ' + amount + ' Style Points for $' + dollarValue.toFixed(2)
    });

    // AML flag if cumulative redemptions >= $600
    const { data: allRedeems } = await supabase
      .from('transactions')
      .select('amount')
      .eq('user_id', req.user.userId)
      .eq('type', 'redeem');

    const totalUSD = (allRedeems || []).reduce((sum, t) => sum + (t.amount || 0), 0);
    if (totalUSD >= 600) {
      await supabase.from('aml_flags').insert({
        user_id: req.user.userId,
        total_redeemed_usd: totalUSD.toFixed(2),
        reason: 'Cumulative redemptions >= $600 (1099-NEC threshold)',
        status: 'pending_review'
      });
      console.warn('[AML] User ' + req.user.userId + ' hit $600 threshold');
    }

    res.json({ new_balance: newOP, store_credits: newCredits, redeemed_points: amount, dollar_value: dollarValue });
  } catch (err) {
    console.error('Redeem error:', err);
    res.status(500).json({ error: 'Redemption failed' });
  }
});

module.exports = router;
