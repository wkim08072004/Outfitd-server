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

module.exports = router;

