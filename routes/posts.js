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

// POST /api/posts — create post
router.post('/', requireAuth, async (req, res) => {
  try {
    const { caption, image_url, tags } = req.body;
    const { data, error } = await supabase.from('posts').insert({
      user_id: req.user.userId, caption: caption || '', image_url: image_url || null, tags: tags || []
    }).select().single();
    if (error) throw error;
    res.status(201).json({ post: data });
  } catch (err) {
    console.error('Post error:', err);
    res.status(500).json({ error: 'Post failed' });
  }
});

// GET /api/posts/feed
router.get('/feed', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 0;
    const limit = 20;
    const { data, error } = await supabase
      .from('posts').select('*, users(handle, display_name, avatar_url)')
      .order('created_at', { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);
    if (error) throw error;
    res.json({ posts: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// POST /api/posts/:id/like
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const { data: post } = await supabase
      .from('posts').select('likes').eq('id', req.params.id).single();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    await supabase.from('posts')
      .update({ likes: (post.likes || 0) + 1 }).eq('id', req.params.id);
    res.json({ likes: (post.likes || 0) + 1 });
  } catch (err) {
    res.status(500).json({ error: 'Like failed' });
  }
});

module.exports = router;
