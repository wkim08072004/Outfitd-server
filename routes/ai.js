// ═══════════════════════════════════════════════════════════════
// ai.js — AI proxy routes (Anthropic API)
// Drop into /Users/eshapatel/outfitd-server/routes/ai.js
// Add to server.js: app.use('/api/ai', require('./routes/ai'));
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

// ── Rate limit: 20 AI requests per user per minute ──
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Too many AI requests — try again in a minute' },
});

// ── Auth middleware ──
const jwt = require('jsonwebtoken');
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

// ── Input sanitizer ──
function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  // Strip control characters, limit length
  return str.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLen || 200);
}

// ═══════════════════════════════════════════════════════════════
// POST /api/ai/suggest — Outfit suggestion proxy
// ═══════════════════════════════════════════════════════════════
router.post('/suggest', requireAuth, aiLimiter, async (req, res) => {
  try {
    const pieces = sanitize(req.body.pieces, 1000);
    const missing = sanitize(req.body.missing, 200);
    const budget = Math.min(Math.max(0, Number(req.body.budget) || 0), 100000);

    if (!pieces) {
      return res.status(400).json({ error: 'No outfit pieces provided' });
    }

    const prompt = `You are a fashion stylist AI for OUTFITD, a streetwear social commerce platform. Based on this outfit so far:
${pieces}
Budget spent: $${budget}
Empty slots: ${missing}
In 2-3 sentences, suggest what to add to complete the outfit — be specific about style, color, and type of item. Keep it casual and hype. No markdown.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const suggestion =
      data.content?.[0]?.text ||
      'Looking good! Try adding something that contrasts your current palette.';

    return res.json({ suggestion });
  } catch (err) {
    console.error('AI suggest error:', err);
    return res.json({
      suggestion: 'Looking fire so far! Try balancing with a neutral piece to tie it together.',
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/ai/search — Shop search proxy
// ═══════════════════════════════════════════════════════════════
router.post('/search', requireAuth, aiLimiter, async (req, res) => {
  try {
    const query = sanitize(req.body.query, 200);
    if (!query) return res.status(400).json({ error: 'No query provided' });

    const prompt = `You are a shopping assistant for OUTFITD. The user searched for: "${query}". Return a JSON array of up to 5 relevant search filter suggestions (e.g. style tags, categories, price ranges). Format: [{"tag":"streetwear"},{"tag":"under $50"}]. Only return valid JSON, nothing else.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    return res.json({ results: text });
  } catch (err) {
    console.error('AI search error:', err);
    return res.json({ results: '[]' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/ai/moderate-image — Photo moderation gate
// Used before publishing a feed post or listing photo. Returns
//   { safe: boolean, reason?: string }
// On any API error we fail-open (safe:true) — do not block legitimate
// uploads because Anthropic is having a bad day. Tighten later if abuse
// shows up.
// ═══════════════════════════════════════════════════════════════
router.post('/moderate-image', requireAuth, aiLimiter, async (req, res) => {
  try {
    const raw = (req.body.image || '').toString();
    if (!raw) return res.status(400).json({ error: 'No image provided' });

    let mediaType = 'image/jpeg';
    let b64 = raw;
    const m = raw.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,(.+)$/i);
    if (m) {
      mediaType = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
      b64 = m[2];
    }
    // Crude payload cap (~8MB of base64). Bigger uploads waste tokens
    // and the listing/post photo flow already compresses client-side.
    if (b64.length > 11_000_000) {
      return res.json({ safe: true, skipped: 'too_large' });
    }

    const prompt = `You are a content-moderation classifier for OUTFITD, a fashion / apparel marketplace. Decide whether this image is appropriate to publish on a public feed and shop.

ALLOW: clothing, outfits, accessories, shoes, jewelry, flat-lay product shots, mirror selfies showing outfits, fashion photography, model shots in clothing, bags, hats. Mannequins are fine. Tasteful swimwear/lingerie product photos on a hanger or flat-lay are fine.

BLOCK: nudity or partial nudity, sexually suggestive poses, explicit content, hate symbols, weapons, drugs, gore, violence, minors in revealing clothing, anything illegal, screenshots of unrelated content (memes, text, gambling).

Respond with strict JSON only, no prose, no markdown:
{"safe": true|false, "reason": "short string if false, omit if true"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      console.warn('[moderate-image] anthropic non-OK:', response.status);
      return res.json({ safe: true, skipped: 'upstream_error' });
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text || '').trim();
    let parsed = null;
    try {
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      }
    } catch (_) {}

    if (!parsed || typeof parsed.safe !== 'boolean') {
      return res.json({ safe: true, skipped: 'unparseable' });
    }

    return res.json({
      safe: parsed.safe,
      reason: parsed.safe ? undefined : (parsed.reason || 'inappropriate content'),
    });
  } catch (err) {
    console.error('[moderate-image] error:', err);
    // Fail-open: don't block users when moderation itself is broken.
    return res.json({ safe: true, skipped: 'exception' });
  }
});

module.exports = router;
