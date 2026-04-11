// routes/notifications.js
const express = require('express');
const router = express.Router();

// GET /api/notifications — fetch user's notifications
router.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const supabase = req.app.locals.supabase;
    const limit = parseInt(req.query.limit) || 30;

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    const unreadCount = (data || []).filter(n => !n.read).length;
    res.json({ notifications: data || [], unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/notifications/:id/read — mark single as read
router.patch('/:id/read', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const supabase = req.app.locals.supabase;

    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', userId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/notifications/read-all — mark all as read
router.patch('/read-all', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const supabase = req.app.locals.supabase;

    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications/:id — delete single notification
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const supabase = req.app.locals.supabase;

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', userId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
