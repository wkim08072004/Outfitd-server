const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Too many AI requests' } });
router.use(aiLimiter);

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) { res.status(401).json({ error: 'Invalid session' }); }
}

function sanitize(str) {
  if (!str) return '';
  return str.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 200).trim();
}

router.post('/search', requireAuth, async (req, res) => {
  try {
    const query = sanitize(req.body.query);
    if (!query) return res.status(400).json({ error: 'Query required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content: 'You are a fashion shopping assistant for Outfitd. User searched: "' + query + '". Suggest 3-5 relevant items. Be brief. No links.' }] })
    });
    const data = await response.json();
    res.json({ result: data.content && data.content[0] ? data.content[0].text : 'No suggestions.' });
  } catch (err) { console.error('AI search error:', err); res.status(500).json({ error: 'AI search failed' }); }
});

router.post('/suggest', requireAuth, async (req, res) => {
  try {
    const query = sanitize(req.body.query);
    if (!query) return res.status(400).json({ error: 'Query required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: 'You are a streetwear style advisor for Outfitd. User asks: "' + query + '". Give a brief styling suggestion. No links.' }] })
    });
    const data = await response.json();
    res.json({ result: data.content && data.content[0] ? data.content[0].text : 'No suggestions.' });
  } catch (err) { console.error('AI suggest error:', err); res.status(500).json({ error: 'AI suggest failed' }); }
});

module.exports = router;
