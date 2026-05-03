// Image moderation pipeline orchestrator.
//
// Pipeline steps (called in order from the upload route):
//   1. sniff (sniff.js, called by the route directly)
//   2. sha256 + isBanned   — exact-hash block list
//   3. classify            — Anthropic vision today; AWS Rekognition stub
//   4. recordHash + recordDecision  — audit log
//   5. queueReview         — soft-flagged uploads land in admin queue
//   6. maybeEscalateCsam   — defense-in-depth, see README for legal
//
// Decision actions are one of:
//   'pass'      — publish normally
//   'soft_flag' — publish but queue for admin review (Phase 2 will hold
//                 these private until an admin approves)
//   'reject'    — block at upload, ban the hash, return generic error
//
// Failure mode: any classifier exception or upstream error returns
// soft_flag, never pass. Spec §7.

const crypto = require('crypto');
const supabase = require('../supabase');

// ──────────────────────────────────────────────────────────────────────
// Hashing + ban list
// ──────────────────────────────────────────────────────────────────────

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function isBanned(sha) {
  try {
    const { data } = await supabase
      .from('banned_image_hashes')
      .select('sha256')
      .eq('sha256', sha)
      .maybeSingle();
    return !!data;
  } catch (e) {
    console.error('[moderation] isBanned lookup failed:', e.message || e);
    return false; // fail open on lookup errors so legit uploads aren't blocked
  }
}

async function banHash(sha, reason, bannedBy) {
  try {
    const { error } = await supabase.from('banned_image_hashes').insert({
      sha256: sha,
      reason: (reason || 'unspecified').slice(0, 200),
      banned_by: bannedBy || null,
    });
    if (error && error.code !== '23505') throw error;
  } catch (e) {
    console.error('[moderation] banHash failed:', e.message || e);
  }
}

async function recordHash({ sha256: sha, uploaderId, imageUrl }) {
  try {
    await supabase.from('image_hashes').insert({
      sha256: sha,
      uploader_id: uploaderId || null,
      image_url: imageUrl || null,
    });
  } catch (e) {
    console.error('[moderation] recordHash failed:', e.message || e);
  }
}

async function recordDecision({ sha256: sha, uploaderId, imageUrl, decision }) {
  try {
    await supabase.from('moderation_results').insert({
      sha256: sha,
      uploader_id: uploaderId || null,
      image_url: imageUrl || null,
      classifier: decision.classifier || 'unknown',
      action: decision.action,
      reasons: decision.reasons || [],
      raw: decision.raw || {},
    });
    // Structured log for Logtail / Render logs.
    console.log(JSON.stringify({
      evt: 'moderation_decision',
      sha256: sha,
      uploader: uploaderId || null,
      classifier: decision.classifier,
      action: decision.action,
      reasons: decision.reasons || [],
    }));
  } catch (e) {
    console.error('[moderation] recordDecision failed:', e.message || e);
  }
}

async function queueReview({ sha256: sha, uploaderId, imageUrl, reasons }) {
  try {
    await supabase.from('flagged_uploads').insert({
      sha256: sha,
      uploader_id: uploaderId || null,
      image_url: imageUrl || null,
      reasons: reasons || [],
      status: 'pending',
    });
  } catch (e) {
    console.error('[moderation] queueReview failed:', e.message || e);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Classifier — Anthropic vision (real, currently the primary)
// ──────────────────────────────────────────────────────────────────────

// Use the current Haiku 4.5 model — fast for an "instant" check, and the
// claude-sonnet-4-20250514 fallback was 400-ing on every call (which was
// being silently masked by /api/ai/moderate-image's fail-open behavior).
// The actual error body now lands in moderation_results.raw.body so we
// can see exactly why if it ever fails again.
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_TIMEOUT_MS = 12000;
const ANTHROPIC_PROMPT =
`You are a content-moderation classifier for OUTFITD, a fashion / apparel
marketplace. Decide whether this image is appropriate to publish on a
public feed and shop.

ALLOW: clothing, outfits, accessories, shoes, jewelry, flat-lay product
shots, mirror selfies showing outfits, fashion photography, model shots
in clothing, bags, hats. Mannequins are fine. Tasteful swimwear /
lingerie product photos on a hanger or flat-lay are fine.

BLOCK: nudity or partial nudity, sexually suggestive poses, explicit
content, hate symbols, weapons, drugs, gore, violence, minors in
revealing clothing, anything illegal, screenshots of unrelated content
(memes, text, gambling).

Respond with strict JSON only, no prose, no markdown:
{"safe": true|false, "reason": "short string if false, omit if true"}`;

async function classifyAnthropic({ buffer, mediaType }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { classifier: 'anthropic', action: 'soft_flag', reasons: ['no_api_key'], raw: {} };
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
            { type: 'text', text: ANTHROPIC_PROMPT },
          ],
        }],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) {
      // Capture the body so the next 400 / 401 / 429 actually tells us
      // what Anthropic is complaining about — without this we just see
      // 'upstream_error' over and over with no idea of the cause.
      let bodyText = '';
      try { bodyText = await r.text(); } catch (_) {}
      console.warn('[moderation] anthropic non-OK:', r.status, 'body:', bodyText.slice(0, 500));
      return {
        classifier: 'anthropic',
        action: 'soft_flag',
        reasons: ['upstream_error_' + r.status],
        raw: { status: r.status, body: bodyText.slice(0, 500), bytes: buffer.length, model: ANTHROPIC_MODEL },
      };
    }
    const data = await r.json();
    const text = (data.content?.[0]?.text || '').trim();
    let parsed = null;
    try {
      const jStart = text.indexOf('{');
      const jEnd = text.lastIndexOf('}');
      if (jStart >= 0 && jEnd > jStart) parsed = JSON.parse(text.slice(jStart, jEnd + 1));
    } catch (_) {}
    if (!parsed || typeof parsed.safe !== 'boolean') {
      return { classifier: 'anthropic', action: 'soft_flag', reasons: ['unparseable'], raw: { text } };
    }
    if (parsed.safe) {
      return { classifier: 'anthropic', action: 'pass', reasons: [], raw: parsed };
    }
    return { classifier: 'anthropic', action: 'reject', reasons: [parsed.reason || 'unsafe'], raw: parsed };
  } catch (err) {
    clearTimeout(timeout);
    console.error('[moderation] anthropic exception:', err.message || err);
    return { classifier: 'anthropic', action: 'soft_flag', reasons: ['exception'], raw: { error: String(err.message || err) } };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Classifier — AWS Rekognition (STUB, disabled).
//
// Returns null when not configured so the orchestrator falls through to
// the next classifier. To enable, set:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
// install @aws-sdk/client-rekognition, and replace the body with a real
// DetectModerationLabels call. Threshold mapping per spec §3:
//   hard reject  > 80%: Explicit Nudity, Sexual Activity, Graphic Violence,
//                       Visually Disturbing
//   soft flag        : Suggestive, Violence < 80%, Drugs, Tobacco,
//                       Alcohol, Hate Symbols
//   pass             : nothing flagged or all < 30%
// ──────────────────────────────────────────────────────────────────────
async function classifyRekognition(/* { buffer, mediaType } */) {
  if (!process.env.AWS_ACCESS_KEY_ID) return null;
  console.warn('[moderation] AWS_ACCESS_KEY_ID set but Rekognition implementation is stubbed');
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Classifier — OCR + text moderation (STUB, disabled).
//
// Spec §4: AWS Textract OR Rekognition DetectText, then OpenAI moderation
// endpoint. We don't have AWS or OPENAI_API_KEY today, so this returns
// null. The Anthropic classifier above already reads any text rendered
// in the image as part of its decision, so this is a defense-in-depth
// upgrade rather than a missing critical layer.
// ──────────────────────────────────────────────────────────────────────
async function classifyText(/* { buffer, mediaType } */) {
  if (!process.env.OPENAI_API_KEY) return null;
  console.warn('[moderation] OPENAI_API_KEY set but text moderation is stubbed');
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Orchestrator — runs configured classifiers in order, returns one
// decision. Today there's only Anthropic; the AWS stub returns null and
// we fall through. Per spec §3 the AWS Rekognition path is the primary
// once configured; reorder this when you wire it.
// ──────────────────────────────────────────────────────────────────────
async function classify({ buffer, mediaType }) {
  const aws = await classifyRekognition({ buffer, mediaType });
  if (aws) return aws;
  return classifyAnthropic({ buffer, mediaType });
}

// ──────────────────────────────────────────────────────────────────────
// CSAM defense-in-depth.
//
// This function is intentionally minimal because real CSAM detection
// requires PhotoDNA (Microsoft approval, weeks of lead time) and NCMEC
// reporting requires registration as an Electronic Service Provider per
// 18 U.S.C. § 2258A. Until both are in place we:
//   - hard-reject (already happens via the regular reject path)
//   - log a row to csam_reports for manual human-in-the-loop review
//   - freeze the uploader account by setting users.role = 'banned'
//   - DO NOT auto-file with NCMEC — that's a deliberate manual step
//     until we're a registered ESP.
//
// TODO(legal): once registered as an NCMEC ESP, wire the CyberTipline
// API and add PhotoDNA hash matching. See 18 U.S.C. § 2258A(a)(1).
// ──────────────────────────────────────────────────────────────────────
async function maybeEscalateCsam({ sha256: sha, uploaderId, decision }) {
  const reasons = (decision.reasons || []).join(' ').toLowerCase();
  const sexualWords = /(sexual|nudity|nude|explicit|genital|porn)/;
  const minorWords  = /(minor|child|kid|underage|teen|baby|infant|juvenile)/;
  if (!sexualWords.test(reasons) || !minorWords.test(reasons)) return;

  console.error('[moderation] CSAM-ESCALATION sha256=' + sha + ' uploader=' + (uploaderId || 'unknown'));

  try {
    await supabase.from('csam_reports').insert({
      sha256: sha,
      uploader_id: uploaderId || null,
      classifier: decision.classifier || 'unknown',
      reasons: decision.reasons || [],
      raw: decision.raw || {},
      notes: 'Auto-escalated by classifier reason match. Requires manual review.',
    });
    if (uploaderId) {
      await supabase.from('users').update({ role: 'banned' }).eq('id', uploaderId);
    }
    // TODO: Resend email alert to admin (no RESEND_API_KEY today).
  } catch (e) {
    console.error('[moderation] csam_reports insert failed:', e.message || e);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Post-side gate. Returns true ONLY if the URL has a recorded image_hashes
// row AND the latest moderation_results row for that sha256 is 'pass'.
// Used by routes/posts.js (and should be added to listings) to refuse any
// photo that didn't go through the upload pipeline or didn't actually
// pass classification.
//
// Inline base64 / data URLs always return false: there's no upload record
// for them, which is exactly what we want — they're a bypass attempt.
// ──────────────────────────────────────────────────────────────────────
async function urlIsApproved(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('data:')) return false;
  try {
    const { data: hash } = await supabase
      .from('image_hashes')
      .select('sha256')
      .eq('image_url', url)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!hash) return false;
    if (await isBanned(hash.sha256)) return false;
    const { data: result } = await supabase
      .from('moderation_results')
      .select('action')
      .eq('sha256', hash.sha256)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return !!(result && result.action === 'pass');
  } catch (e) {
    console.error('[moderation] urlIsApproved failed:', e.message || e);
    // Fail closed — if we can't verify, don't allow. Better to block a
    // legitimate post than to publish something that was never checked.
    return false;
  }
}

module.exports = {
  sha256,
  isBanned,
  banHash,
  recordHash,
  recordDecision,
  queueReview,
  classify,
  classifyAnthropic,
  classifyRekognition,
  classifyText,
  maybeEscalateCsam,
  urlIsApproved,
};
