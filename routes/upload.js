// upload.js — Image upload to Supabase Storage.
// Mount in server.js: app.use('/api/upload', require('./routes/upload'));
//
// Upload-side moderation was removed at the user's request — they prefer
// reactive moderation (delete from the admin queue / via the user's own
// trash button) over a pre-publish gate. Bad uploads can still be banned
// retroactively by inserting their SHA-256 into banned_image_hashes
// (table is still in place; just unused on the upload path now).
// ═══════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Auth tokens are signed with `{ userId }`; normalise so handlers can
    // safely read req.user.id without writing 'undefined' into file paths.
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

    const ext = matches[1].toLowerCase() === 'jpeg' ? 'jpg' : matches[1].toLowerCase();
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large — max 8MB' });
    }

    const bucketFolder = (folder || 'uploads').replace(/[^a-zA-Z0-9_/-]/g, '');
    const fileName = `${bucketFolder}/${req.user.id || 'anon'}_${Date.now()}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from('images')
      .upload(fileName, buffer, {
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: false,
      });
    if (uploadErr) throw uploadErr;

    const { data: urlData } = supabase.storage.from('images').getPublicUrl(fileName);
    res.json({ url: urlData.publicUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
