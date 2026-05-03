// upload.js — Image upload to Supabase Storage with moderation pipeline.
// Mount in server.js: app.use('/api/upload', require('./routes/upload'));
//
// Pipeline (see lib/moderation/README.md for what's stubbed):
//   sniff → sha256 → ban check → classify → store → audit → queue if soft.
//
// Response shapes (kept backwards-compatible with existing callers —
// avatars / banners / listings still get a flat { url }):
//   pass      → { url, sha256 }
//   soft_flag → { url, sha256, queuedForReview: true,
//                 message: "Your post is being reviewed and will appear shortly." }
//   reject    → 403 { error: "This image violates our content policy." }
//   ban hit   → 403 { error: "This image violates our content policy." }
// ═══════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');
const sniff = require('../lib/moderation/sniff');
const moderation = require('../lib/moderation');

const MAX_BYTES = 10 * 1024 * 1024; // spec §1: 10 MB hard cap
const GENERIC_REJECT_MESSAGE = 'This image violates our content policy.'; // spec §8: never leak which classifier

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Auth tokens are signed with `{ userId }`; normalise so handlers can
    // safely read req.user.id without writing NULL uploader_ids.
    decoded.id = decoded.userId || decoded.id || decoded.sub || decoded.user_id;
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { file, folder } = req.body;

    if (!file || typeof file !== 'string' || !file.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data' });
    }
    const matches = file.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid base64 format' });

    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'File too large — max 10MB' });
    }

    // Step 1: magic-byte sniff. The data-URL Content-Type prefix is
    // attacker-controlled — a polyglot file can claim image/png while
    // actually being something else.
    const sniffed = sniff.detect(buffer);
    if (!sniffed.ok) {
      return res.status(400).json({ error: sniffed.reason });
    }
    const { mediaType, ext } = sniffed;

    // Step 2: hash + exact-match ban list.
    const sha = moderation.sha256(buffer);
    const uploaderId = req.user.id;
    if (await moderation.isBanned(sha)) {
      await moderation.recordDecision({
        sha256: sha,
        uploaderId,
        imageUrl: null,
        decision: { classifier: 'ban_list', action: 'reject', reasons: ['banned_hash'], raw: {} },
      });
      return res.status(403).json({ error: GENERIC_REJECT_MESSAGE });
    }

    // Step 3: classify. Anthropic vision today; AWS Rekognition stub in
    // the orchestrator falls through until configured. Failure mode is
    // soft_flag, never silent pass.
    const decision = await moderation.classify({ buffer, mediaType });

    // Step 4a: hard reject — ban the hash, audit, escalate if CSAM-shaped,
    // return generic message (never reveal which category).
    if (decision.action === 'reject') {
      await moderation.banHash(sha, decision.reasons.join(',') || 'classifier_reject', uploaderId);
      await moderation.recordDecision({ sha256: sha, uploaderId, imageUrl: null, decision });
      await moderation.maybeEscalateCsam({ sha256: sha, uploaderId, decision });
      return res.status(403).json({ error: GENERIC_REJECT_MESSAGE });
    }

    // Step 4b: store (pass + soft_flag both upload). Soft-flag staying
    // public until admin acts is documented in lib/moderation/README.
    const bucketFolder = (folder || 'uploads').replace(/[^a-zA-Z0-9_/-]/g, '');
    const fileName = `${bucketFolder}/${uploaderId || 'anon'}_${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from('images')
      .upload(fileName, buffer, { contentType: mediaType, upsert: false });
    if (uploadErr) throw uploadErr;
    const { data: urlData } = supabase.storage.from('images').getPublicUrl(fileName);
    const url = urlData.publicUrl;

    // Step 5: audit log + forensic hash record.
    await moderation.recordHash({ sha256: sha, uploaderId, imageUrl: url });
    await moderation.recordDecision({ sha256: sha, uploaderId, imageUrl: url, decision });

    // Step 6: soft-flag → queue for admin review. Still return the URL
    // so existing callers (avatars / banners / listings) keep working;
    // post creation can opt into the pending UX via queuedForReview.
    if (decision.action === 'soft_flag') {
      await moderation.queueReview({
        sha256: sha,
        uploaderId,
        imageUrl: url,
        reasons: decision.reasons,
      });
      return res.json({
        url,
        sha256: sha,
        queuedForReview: true,
        message: 'Your post is being reviewed and will appear shortly.',
      });
    }

    res.json({ url, sha256: sha });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
