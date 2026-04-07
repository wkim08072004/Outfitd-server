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

// POST /api/battles/challenge
router.post('/challenge', requireAuth, async (req, res) => {
  try {
    const { opponent_id, wager_amount, wager_currency, challenger_image } = req.body;
    const currency = wager_currency === 'store_credits' ? 'store_credits' : 'op_balance';

    if (opponent_id === req.user.userId)
      return res.status(400).json({ error: 'Cannot challenge yourself' });

    // Check challenger balance
    const { data: challenger } = await supabase
      .from('users').select(currency).eq('id', req.user.userId).single();

    if (!challenger || (challenger[currency] || 0) < wager_amount)
      return res.status(400).json({ error: 'Insufficient balance' });

    // Deduct from challenger
    await supabase.from('users')
      .update({ [currency]: challenger[currency] - wager_amount })
      .eq('id', req.user.userId);

    // Log transaction
    await supabase.from('transactions').insert({
      user_id: req.user.userId, type: 'battle_escrow', currency,
      amount: -wager_amount, description: 'Battle wager escrow'
    });

    // Create battle
    const { data: battle, error } = await supabase.from('battles').insert({
      challenger_id: req.user.userId,
      opponent_id,
      challenger_image: challenger_image || null,
      wager_amount: wager_amount || 0,
      wager_currency: currency,
      status: 'pending',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }).select().single();

    if (error) throw error;
    res.status(201).json({ battle });
  } catch (err) {
    console.error('Challenge error:', err);
    res.status(500).json({ error: 'Challenge failed' });
  }
});

// POST /api/battles/accept
router.post('/accept', requireAuth, async (req, res) => {
  try {
    const { battle_id, opponent_image } = req.body;

    const { data: battle } = await supabase
      .from('battles').select('*').eq('id', battle_id).eq('status', 'pending').single();

    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    if (battle.opponent_id !== req.user.userId)
      return res.status(403).json({ error: 'Not your battle' });

    const currency = battle.wager_currency;

    // Check opponent balance
    const { data: opponent } = await supabase
      .from('users').select(currency).eq('id', req.user.userId).single();

    if (!opponent || (opponent[currency] || 0) < battle.wager_amount)
      return res.status(400).json({ error: 'Insufficient balance' });

    // Deduct from opponent
    await supabase.from('users')
      .update({ [currency]: opponent[currency] - battle.wager_amount })
      .eq('id', req.user.userId);

    await supabase.from('transactions').insert({
      user_id: req.user.userId, type: 'battle_escrow', currency,
      amount: -battle.wager_amount, description: 'Battle wager escrow'
    });

    // Update battle to active
    await supabase.from('battles')
      .update({ status: 'active', opponent_image: opponent_image || null })
      .eq('id', battle_id);

    res.json({ success: true });
  } catch (err) {
    console.error('Accept error:', err);
    res.status(500).json({ error: 'Accept failed' });
  }
});

// POST /api/battles/:id/vote
router.post('/:id/vote', requireAuth, async (req, res) => {
  try {
    const { voted_for } = req.body;
    const battle_id = req.params.id;

    const { data: battle } = await supabase
      .from('battles').select('*').eq('id', battle_id).eq('status', 'active').single();

    if (!battle) return res.status(404).json({ error: 'Battle not found or not active' });

    // Cannot vote on own battle
    if (req.user.userId === battle.challenger_id || req.user.userId === battle.opponent_id)
      return res.status(403).json({ error: 'Cannot vote on your own battle' });

    // Insert vote (unique constraint prevents double voting)
    const { error } = await supabase.from('battle_votes').insert({
      battle_id, user_id: req.user.userId, voted_for
    });

    if (error && error.code === '23505')
      return res.status(400).json({ error: 'Already voted' });
    if (error) throw error;

    // Increment vote count
    const field = voted_for === battle.challenger_id ? 'votes_challenger' : 'votes_opponent';
    await supabase.from('battles')
      .update({ [field]: (battle[field] || 0) + 1 })
      .eq('id', battle_id);

    res.json({ success: true });
  } catch (err) {
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Vote failed' });
  }
});

// POST /api/battles/:id/close — admin or auto-close
router.post('/:id/close', requireAuth, async (req, res) => {
  try {
    const battle_id = req.params.id;

    const { data: battle } = await supabase
      .from('battles').select('*').eq('id', battle_id).eq('status', 'active').single();

    if (!battle) return res.status(404).json({ error: 'Battle not found' });

    // Determine winner
    let winner_id;
    if (battle.votes_challenger > battle.votes_opponent) winner_id = battle.challenger_id;
    else if (battle.votes_opponent > battle.votes_challenger) winner_id = battle.opponent_id;
    else winner_id = null; // tie — refund both

    const currency = battle.wager_currency;
    const totalPot = battle.wager_amount * 2;

    if (winner_id) {
      // Award winner
      const { data: winner } = await supabase
        .from('users').select(currency).eq('id', winner_id).single();

      await supabase.from('users')
        .update({ [currency]: (winner[currency] || 0) + totalPot })
        .eq('id', winner_id);

      await supabase.from('transactions').insert({
        user_id: winner_id, type: 'battle_win', currency,
        amount: totalPot, description: 'Battle victory', reference_id: battle_id
      });
    } else {
      // Tie — refund both
      for (const uid of [battle.challenger_id, battle.opponent_id]) {
        const { data: u } = await supabase.from('users').select(currency).eq('id', uid).single();
        await supabase.from('users')
          .update({ [currency]: (u[currency] || 0) + battle.wager_amount })
          .eq('id', uid);
        await supabase.from('transactions').insert({
          user_id: uid, type: 'battle_refund', currency,
          amount: battle.wager_amount, description: 'Battle tie refund', reference_id: battle_id
        });
      }
    }

    await supabase.from('battles')
      .update({ status: 'closed', winner_id })
      .eq('id', battle_id);

    res.json({ winner_id, status: 'closed' });
  } catch (err) {
    console.error('Close error:', err);
    res.status(500).json({ error: 'Close failed' });
  }
});

// GET /api/battles — list battles
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('battles')
      .select('*')
      .in('status', ['active', 'pending'])
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ battles: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch battles' });
  }
});

module.exports = router;
