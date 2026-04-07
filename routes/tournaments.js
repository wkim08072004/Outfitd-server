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

async function requireAdmin(req, res, next) {
  const { data: user } = await supabase.from('users').select('role').eq('id', req.user.userId).single();
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// GET /api/tournaments — list open/active
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('prestige_tournaments').select('*')
      .in('status', ['open', 'active'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ tournaments: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

// POST /api/tournaments — admin create
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description, prize_pool, entry_fee, max_entries, theme, starts_at, ends_at } = req.body;
    const { data, error } = await supabase.from('prestige_tournaments').insert({
      title, description, prize_pool: prize_pool || 0, entry_fee: entry_fee || 0,
      max_entries: max_entries || 64, theme: theme || '', status: 'open',
      starts_at, ends_at, created_by: req.user.userId
    }).select().single();
    if (error) throw error;
    res.status(201).json({ tournament: data });
  } catch (err) {
    console.error('Tournament create error:', err);
    res.status(500).json({ error: 'Create failed' });
  }
});

// POST /api/tournaments/:id/join
router.post('/:id/join', requireAuth, async (req, res) => {
  try {
    const { image_url } = req.body;
    const tournament_id = req.params.id;

    const { data: tourney } = await supabase
      .from('prestige_tournaments').select('*').eq('id', tournament_id).eq('status', 'open').single();
    if (!tourney) return res.status(404).json({ error: 'Tournament not found or closed' });

    // Check entry count
    const { count } = await supabase
      .from('prestige_entries').select('id', { count: 'exact' }).eq('tournament_id', tournament_id);
    if (count >= tourney.max_entries) return res.status(400).json({ error: 'Tournament full' });

    // Deduct entry fee if any
    if (tourney.entry_fee > 0) {
      const { data: user } = await supabase
        .from('users').select('op_balance').eq('id', req.user.userId).single();
      if (!user || user.op_balance < tourney.entry_fee)
        return res.status(400).json({ error: 'Insufficient OP for entry fee' });

      await supabase.from('users')
        .update({ op_balance: user.op_balance - tourney.entry_fee })
        .eq('id', req.user.userId);

      await supabase.from('transactions').insert({
        user_id: req.user.userId, type: 'tournament_entry', currency: 'op_balance',
        amount: -tourney.entry_fee, description: `Entry fee: ${tourney.title}`, reference_id: tournament_id
      });
    }

    const { data: entry, error } = await supabase.from('prestige_entries').insert({
      tournament_id, user_id: req.user.userId, image_url: image_url || null
    }).select().single();

    if (error && error.code === '23505') return res.status(400).json({ error: 'Already entered' });
    if (error) throw error;
    res.status(201).json({ entry });
  } catch (err) {
    console.error('Join error:', err);
    res.status(500).json({ error: 'Join failed' });
  }
});

// POST /api/tournaments/:id/vote
router.post('/:id/vote', requireAuth, async (req, res) => {
  try {
    const { entry_id } = req.body;

    const { error } = await supabase.from('prestige_votes').insert({
      entry_id, user_id: req.user.userId
    });

    if (error && error.code === '23505') return res.status(400).json({ error: 'Already voted' });
    if (error) throw error;

    // Increment vote count
    const { data: entry } = await supabase
      .from('prestige_entries').select('vote_count').eq('id', entry_id).single();
    await supabase.from('prestige_entries')
      .update({ vote_count: (entry.vote_count || 0) + 1 }).eq('id', entry_id);

    res.json({ success: true });
  } catch (err) {
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Vote failed' });
  }
});

// POST /api/tournaments/:id/end — admin ends and distributes prizes
router.post('/:id/end', requireAuth, requireAdmin, async (req, res) => {
  try {
    const tournament_id = req.params.id;
    const { data: tourney } = await supabase
      .from('prestige_tournaments').select('*').eq('id', tournament_id).single();
    if (!tourney) return res.status(404).json({ error: 'Not found' });

    // Get entries ranked by votes
    const { data: entries } = await supabase
      .from('prestige_entries').select('*').eq('tournament_id', tournament_id)
      .order('vote_count', { ascending: false });

    // Distribute prizes: 50% to 1st, 30% to 2nd, 20% to 3rd
    const splits = [0.5, 0.3, 0.2];
    for (let i = 0; i < Math.min(3, entries.length); i++) {
      const prize = Math.floor(tourney.prize_pool * splits[i]);
      const uid = entries[i].user_id;

      const { data: u } = await supabase.from('users').select('op_balance').eq('id', uid).single();
      await supabase.from('users').update({ op_balance: (u.op_balance || 0) + prize }).eq('id', uid);
      await supabase.from('transactions').insert({
        user_id: uid, type: 'tournament_prize', currency: 'op_balance',
        amount: prize, description: `#${i+1} in ${tourney.title}`, reference_id: tournament_id
      });
      await supabase.from('prestige_entries').update({ rank: i + 1 }).eq('id', entries[i].id);
    }

    await supabase.from('prestige_tournaments').update({ status: 'ended' }).eq('id', tournament_id);
    res.json({ success: true, winners: entries.slice(0, 3).map(e => e.user_id) });
  } catch (err) {
    console.error('End tournament error:', err);
    res.status(500).json({ error: 'End failed' });
  }
});

module.exports = router;
