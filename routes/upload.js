// upload.js — Image upload to Supabase Storage
// Mount in server.js: app.use('/api/upload', require('./routes/upload'));
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
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// POST /api/upload
// Expects JSON body: { file: "data:image/...;base64,...", folder: "avatars"|"posts"|"banners"|"listings" }
// Returns: { url: "https://...supabase.co/storage/v1/object/public/images/..." }
router.post('/', requireAuth, async (req, res) => {
  try {
    const { file, folder } = req.body;

    if (!file || !file.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data' });
    }

    // Parse base64
    const matches = file.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid base64 format' });

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // Max 8MB
    if (buffer.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large — max 8MB' });
    }

    const bucketFolder = folder || 'uploads';
    const fileName = `${bucketFolder}/${req.user.id}_${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('images')
      .upload(fileName, buffer, {
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: false
      });

    if (error) throw error;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('images')
      .getPublicUrl(fileName);

    res.json({ url: urlData.publicUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
