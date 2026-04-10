// ─── posts.js ─── Add to your Express server (outfitd-server)
// Import: const postsRouter = require('./routes/posts');
// Mount: app.use('/api/posts', postsRouter);

const express = require('express');
const router = express.Router();

// Assumes you have these already in your server:
//   - supabase client (require it or pass via app.locals)
//   - requireAuth middleware that sets req.user = { id, handle, ... }
// Adjust the imports below to match your project structure:

module.exports = function(supabase, requireAuth) {

  // ─── GET /api/posts ───────────────────────────────────────
  // Query params: ?filter=following|saved&style=Streetwear&limit=50&offset=0
  router.get('/', async (req, res) => {
    try {
      const { filter, style, limit = 50, offset = 0 } = req.query;
      let query = supabase
        .from('posts')
        .select('*')
        .order('created_at', { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1);

      if (style) query = query.eq('style', style);

      const { data: posts, error } = await query;
      if (error) throw error;

      // If user is logged in, attach their like/save status
      let userLikes = {};
      let userSaves = {};
      if (req.user) {
        const postIds = posts.map(p => p.id);
        if (postIds.length) {
          const [likesRes, savesRes] = await Promise.all([
            supabase.from('post_likes').select('post_id').eq('user_id', req.user.id).in('post_id', postIds),
            supabase.from('post_saves').select('post_id').eq('user_id', req.user.id).in('post_id', postIds)
          ]);
          (likesRes.data || []).forEach(r => { userLikes[r.post_id] = true; });
          (savesRes.data || []).forEach(r => { userSaves[r.post_id] = true; });
        }
      }

      const result = posts.map(p => ({
        id: p.id,
        user: p.user_handle,
        avatar: p.avatar,
        avatarPhoto: p.avatar_photo,
        photo: p.photo,
        title: p.title,
        style: p.style,
        tags: p.tags || [],
        cost: p.cost,
        emoji: p.emoji || [],
        frame: p.frame,
        bgColor: p.bg_color,
        likes: p.likes_count,
        comments: p.comments_count,
        ts: new Date(p.created_at).getTime(),
        time: _timeAgo(p.created_at),
        isUserPost: req.user ? p.user_id === req.user.id : false,
        liked: !!userLikes[p.id],
        saved: !!userSaves[p.id]
      }));

      res.json({ posts: result });
    } catch (err) {
      console.error('GET /api/posts error:', err);
      res.status(500).json({ error: 'Failed to fetch posts' });
    }
  });

  // ─── POST /api/posts ─────────────────────────────────────
  router.post('/', requireAuth, async (req, res) => {
    try {
      const { title, style, tags, cost, emoji, frame, photo, bgColor } = req.body;

      const sanitizedTitle = (title || 'MY LOOK').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 80);
      const sanitizedTags = (tags || []).map(t => t.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 30)).filter(Boolean).slice(0, 8);
      const sanitizedCost = Math.max(0, Math.min(parseInt(cost) || 0, 99999));

      const postId = Date.now();

      const { data, error } = await supabase.from('posts').insert({
        id: postId,
        user_id: req.user.id,
        user_handle: req.user.handle,
        avatar: req.user.avatar_url || '👤',
        avatar_photo: req.user.avatar_photo || null,
        photo: photo || null,
        title: sanitizedTitle.toUpperCase(),
        style: style || 'Streetwear',
        tags: sanitizedTags,
        cost: sanitizedCost,
        emoji: emoji || ['👕', '👟'],
        frame: frame || null,
        bg_color: bgColor || null
      }).select().single();

      if (error) throw error;

      res.json({
        post: {
          id: data.id,
          user: data.user_handle,
          avatar: data.avatar,
          avatarPhoto: data.avatar_photo,
          photo: data.photo,
          title: data.title,
          style: data.style,
          tags: data.tags,
          cost: data.cost,
          emoji: data.emoji,
          frame: data.frame,
          bgColor: data.bg_color,
          likes: 0,
          comments: 0,
          ts: new Date(data.created_at).getTime(),
          time: 'just now',
          isUserPost: true
        }
      });
    } catch (err) {
      console.error('POST /api/posts error:', err);
      res.status(500).json({ error: 'Failed to create post' });
    }
  });

  // ─── DELETE /api/posts/:id ────────────────────────────────
  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const postId = Number(req.params.id);
      // Verify ownership
      const { data: post } = await supabase.from('posts').select('user_id').eq('id', postId).single();
      if (!post || post.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Not your post' });
      }
      const { error } = await supabase.from('posts').delete().eq('id', postId);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      console.error('DELETE /api/posts error:', err);
      res.status(500).json({ error: 'Failed to delete post' });
    }
  });

  // ─── POST /api/posts/:id/like ─────────────────────────────
  router.post('/:id/like', requireAuth, async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { error } = await supabase.from('post_likes').insert({
        user_id: req.user.id,
        post_id: postId
      });
      // Ignore duplicate key errors (already liked)
      if (error && error.code !== '23505') throw error;
      res.json({ liked: true });
    } catch (err) {
      console.error('POST like error:', err);
      res.status(500).json({ error: 'Failed to like post' });
    }
  });

  // ─── DELETE /api/posts/:id/like ───────────────────────────
  router.delete('/:id/like', requireAuth, async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { error } = await supabase.from('post_likes').delete()
        .eq('user_id', req.user.id).eq('post_id', postId);
      if (error) throw error;
      res.json({ liked: false });
    } catch (err) {
      console.error('DELETE like error:', err);
      res.status(500).json({ error: 'Failed to unlike post' });
    }
  });

  // ─── POST /api/posts/:id/save ─────────────────────────────
  router.post('/:id/save', requireAuth, async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { error } = await supabase.from('post_saves').insert({
        user_id: req.user.id,
        post_id: postId
      });
      if (error && error.code !== '23505') throw error;
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save post' });
    }
  });

  // ─── DELETE /api/posts/:id/save ───────────────────────────
  router.delete('/:id/save', requireAuth, async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { error } = await supabase.from('post_saves').delete()
        .eq('user_id', req.user.id).eq('post_id', postId);
      if (error) throw error;
      res.json({ saved: false });
    } catch (err) {
      res.status(500).json({ error: 'Failed to unsave post' });
    }
  });

  // ─── GET /api/posts/:id/comments ──────────────────────────
  router.get('/:id/comments', async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { data, error } = await supabase.from('post_comments')
        .select('*').eq('post_id', postId).order('created_at', { ascending: true });
      if (error) throw error;
      res.json({
        comments: (data || []).map(c => ({
          id: c.id,
          uid: c.user_handle,
          handle: c.user_handle,
          avi: c.avatar,
          text: c.body,
          ts: new Date(c.created_at).getTime()
        }))
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch comments' });
    }
  });

  // ─── POST /api/posts/:id/comments ─────────────────────────
  router.post('/:id/comments', requireAuth, async (req, res) => {
    try {
      const postId = Number(req.params.id);
      let text = (req.body.text || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 280);
      if (!text) return res.status(400).json({ error: 'Empty comment' });

      const { data, error } = await supabase.from('post_comments').insert({
        post_id: postId,
        user_id: req.user.id,
        user_handle: req.user.handle,
        avatar: req.user.avatar_url || '👤',
        body: text
      }).select().single();

      if (error) throw error;
      res.json({
        comment: {
          id: data.id,
          uid: data.user_handle,
          handle: data.user_handle,
          avi: data.avatar,
          text: data.body,
          ts: new Date(data.created_at).getTime()
        }
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to post comment' });
    }
  });

  return router;
};

// Helper
function _timeAgo(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}
