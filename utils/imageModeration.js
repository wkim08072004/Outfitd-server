// imageModeration.js — Shared AI image moderation helper.
// Single source of truth for /api/upload, /api/posts, and /api/ai/moderate-image.
// Returns { safe, reason?, skipped? }. Fails OPEN on upstream/parse errors so a
// dead Anthropic doesn't block legitimate uploads — but every skip is logged
// so the admin path can sweep the audit later.

async function moderateBase64(rawDataUrl) {
  if (!rawDataUrl) return { safe: true, skipped: 'no_image' };
  if (typeof rawDataUrl !== 'string') return { safe: true, skipped: 'bad_type' };

  // URLs aren't moderated here — caller decides whether to trust them.
  if (rawDataUrl.startsWith('http://') || rawDataUrl.startsWith('https://')) {
    return { safe: true, skipped: 'url' };
  }

  let mediaType = 'image/jpeg';
  let b64 = rawDataUrl;
  const m = rawDataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,(.+)$/i);
  if (m) {
    mediaType = m[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    b64 = m[2];
  }

  // Cap at ~8MB of base64. Bigger uploads waste tokens and the post/listing
  // flows already compress client-side.
  if (b64.length > 11_000_000) return { safe: true, skipped: 'too_large' };

  const prompt = `You are a content-moderation classifier for OUTFITD, a fashion / apparel marketplace. Decide whether this image is appropriate to publish on a public feed and shop.

ALLOW: clothing, outfits, accessories, shoes, jewelry, flat-lay product shots, mirror selfies showing outfits, fashion photography, model shots in clothing, bags, hats. Mannequins are fine. Tasteful swimwear/lingerie product photos on a hanger or flat-lay are fine.

BLOCK: nudity or partial nudity, sexually suggestive poses, explicit content, hate symbols, weapons, drugs, gore, violence, minors in revealing clothing, anything illegal, screenshots of unrelated content (memes, text, gambling).

Respond with strict JSON only, no prose, no markdown:
{"safe": true|false, "reason": "short string if false, omit if true"}`;

  // Hard timeout so the moderation call can't blow Render's 15s gateway.
  // Haiku usually finishes in 1–3s; an 8s ceiling is generous.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 8000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
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
      console.warn('[moderation] anthropic non-OK:', response.status);
      return { safe: true, skipped: 'upstream_' + response.status };
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
      return { safe: true, skipped: 'unparseable' };
    }

    return {
      safe: parsed.safe,
      reason: parsed.safe ? undefined : (parsed.reason || 'inappropriate content'),
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.warn('[moderation] timed out after 8s');
      return { safe: true, skipped: 'timeout' };
    }
    console.error('[moderation] error:', err);
    return { safe: true, skipped: 'exception' };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { moderateBase64 };
