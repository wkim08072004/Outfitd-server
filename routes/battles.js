// ═══════════════════════════════════════════════════════════════
// battles.js — Style battle routes
// Drop into /Users/eshapatel/outfitd-server/routes/battles.js
// Add to server.js: app.use('/api/battles', require('./routes/battles'));
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
// ═══════════════════════════════════════════════════════════
// GET /api/battles — Fetch all battles
// ═══════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { data: battles, error } = await supabase
      .from('battles')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    const result = (battles || []).map(b => ({
      id: b.id,
      challenger: {
        handle: b.challenger_handle, avi: b.challenger_avi,
        fit: b.challenger_fit || [], style: b.challenger_style,
        cost: b.challenger_cost || 0, desc: b.challenger_desc || ''
      },
      opponent: b.opponent_handle ? {
        handle: b.opponent_handle, avi: b.opponent_avi,
        fit: b.opponent_fit || [], style: b.opponent_style,
        cost: b.opponent_cost || 0, desc: b.opponent_desc || ''
      } : null,
      wager: b.wager, status: b.status,
      deadline: b.deadline ? new Date(b.deadline).getTime() : null,
      votes: { challenger: b.votes_challenger || 0, opponent: b.votes_opponent || 0 },
      winner: b.winner, votedBy: {},
      postedAt: new Date(b.created_at).getTime()
    }));
    res.json({ battles: result });
  } catch (err) {
    console.error('GET /api/battles error:', err);
    res.status(500).json({ error: 'Failed to fetch battles' });
  }
});
// ═══════════════════════════════════════════════════════════════
// POST /api/battles/create — Issue a challenge
// ═══════════════════════════════════════════════════════════════
router.post('/create', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { wager, outfit, style, description } = req.body;
    const wagerAmount = Math.max(0, parseInt(wager) || 0);

    // Verify user has enough balance
    const { data: wallet } = await supabase
      .from('wallets')
      .select('op_balance')
      .eq('user_id', userId)
      .single();

    if (!wallet || wallet.op_balance < wagerAmount) {
      return res.status(400).json({ error: 'Insufficient Style Points' });
    }

    // Deduct wager (escrow)
    await supabase
      .from('wallets')
      .update({ op_balance: wallet.op_balance - wagerAmount })
      .eq('user_id', userId);

    // Create battle
    const { data: battle, error } = await supabase
      .from('battles')
      .insert({
        challenger_id: userId,
        challenger_outfit: outfit || [],
        wager_amount: wagerAmount,
        status: 'open',
      })
      .select()
      .single();

    if (error) throw error;

    // Log escrow transaction
    await supabase.from('transactions').insert({
      user_id: userId,
      type: 'battle_escrow',
      currency: 'style_points',
      amount: -wagerAmount,
      description: `Battle wager escrowed (battle ${battle.id})`,
    });

    return res.json({ battle_id: battle.id, status: 'open' });
  } catch (err) {
    console.error('Battle create error:', err);
    return res.status(500).json({ error: 'Failed to create battle' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/battles/accept — Accept a challenge
// ═══════════════════════════════════════════════════════════════
router.post('/accept', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { battle_id } = req.body;

    const { data: battle } = await supabase
      .from('battles')
      .select('*')
      .eq('id', battle_id)
      .eq('status', 'open')
      .single();

    if (!battle) return res.status(404).json({ error: 'Battle not found or already started' });
    if (battle.challenger_id === userId) return res.status(400).json({ error: "Can't accept your own challenge" });

    // Verify balance
    const { data: wallet } = await supabase
      .from('wallets')
      .select('op_balance')
      .eq('user_id', userId)
      .single();

    if (!wallet || wallet.op_balance < battle.wager_amount) {
      return res.status(400).json({ error: 'Insufficient Style Points' });
    }

    // Deduct wager
    await supabase
      .from('wallets')
      .update({ op_balance: wallet.op_balance - battle.wager_amount })
      .eq('user_id', userId);

    // Update battle to active with 24hr voting window
    const votingEnds = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('battles')
      .update({
        opponent_id: userId,
        status: 'active',
        voting_ends_at: votingEnds,
      })
      .eq('id', battle_id);

    // Log escrow
    await supabase.from('transactions').insert({
      user_id: userId,
      type: 'battle_escrow',
      currency: 'style_points',
      amount: -battle.wager_amount,
      description: `Battle wager escrowed (battle ${battle_id})`,
    });

    return res.json({ status: 'active', voting_ends_at: votingEnds });
  } catch (err) {
    console.error('Battle accept error:', err);
    return res.status(500).json({ error: 'Failed to accept battle' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/battles/vote — Cast a vote
// ═══════════════════════════════════════════════════════════════
router.post('/vote', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { battle_id, side } = req.body;

    if (!['challenger', 'opponent'].includes(side)) {
      return res.status(400).json({ error: 'Invalid vote side' });
    }

    const { data: battle } = await supabase
      .from('battles')
      .select('*')
      .eq('id', battle_id)
      .eq('status', 'active')
      .single();

    if (!battle) return res.status(404).json({ error: 'Battle not found or not active' });

    // Check voting deadline
    if (battle.voting_ends_at && new Date(battle.voting_ends_at) < new Date()) {
      return res.status(400).json({ error: 'Voting has ended' });
    }

    // Can't vote in own battle
    if (userId === battle.challenger_id || userId === battle.opponent_id) {
      return res.status(400).json({ error: "Can't vote in your own battle" });
    }

    // Record vote (unique constraint prevents double-voting)
    const votedFor = side === 'challenger' ? battle.challenger_id : battle.opponent_id;
    const { error: voteErr } = await supabase
      .from('battle_votes')
      .insert({ battle_id, voter_id: userId, voted_for: votedFor });

    if (voteErr) {
      if (voteErr.code === '23505') return res.status(400).json({ error: 'Already voted' });
      throw voteErr;
    }

    // Update vote count
    const field = side === 'challenger' ? 'votes_challenger' : 'votes_opponent';
    await supabase.rpc('increment_battle_votes', { battle_uuid: battle_id, vote_field: field });

    return res.json({ status: 'voted' });
  } catch (err) {
    console.error('Battle vote error:', err);
    return res.status(500).json({ error: 'Vote failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/battles/active — List active/open battles
// ═══════════════════════════════════════════════════════════════
router.get('/active', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('battles')
      .select('*')
      .in('status', ['open', 'active'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    return res.json({ battles: data || [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch battles' });
  }
});

module.exports = router;
