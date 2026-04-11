// utils/notify.js — Insert notifications into Supabase
// Usage: const notify = require('../utils/notify');
//        await notify(supabase, userId, 'battle_invite', 'You were challenged!', 'optional body', { battle_id: '...' });

async function notify(supabase, userId, type, title, body = null, metadata = {}) {
  try {
    const { error } = await supabase.from('notifications').insert({
      user_id: userId,
      type,
      title,
      body,
      metadata,
    });
    if (error) console.error('[notify] insert error:', error.message);
  } catch (err) {
    console.error('[notify] exception:', err.message);
  }
}

module.exports = notify;
