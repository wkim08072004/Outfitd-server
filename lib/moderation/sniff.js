// Magic-byte image type detection.
//
// The Content-Type from the data URL prefix is whatever the client says it is
// — not what the bytes actually are. A polyglot file can claim image/png and
// be a zip with a script appended. Always validate by the leading bytes.
//
// Returns { ok: true,  mediaType, ext }
//      or { ok: false, reason }.

function detect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    return { ok: false, reason: 'Image too small or not a buffer' };
  }
  const b = buf;

  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ok: true, mediaType: 'image/jpeg', ext: 'jpg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A. Animated PNG carries an 'acTL' chunk
  // somewhere after the signature — reject those, we don't want autoplay
  // creatures sneaking past the still-image moderator.
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    const head = b.slice(8, Math.min(b.length, 8 + 4096));
    if (head.indexOf('acTL') !== -1) {
      return { ok: false, reason: 'Animated PNG not allowed' };
    }
    return { ok: true, mediaType: 'image/png', ext: 'png' };
  }

  // WebP: 'RIFF' .... 'WEBP'. Animated WebP has an 'ANIM' chunk.
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    const head = b.slice(12, Math.min(b.length, 12 + 4096));
    if (head.indexOf('ANIM') !== -1) {
      return { ok: false, reason: 'Animated WebP not allowed' };
    }
    return { ok: true, mediaType: 'image/webp', ext: 'webp' };
  }

  // GIF: 47 49 46 — banned outright (animated by design).
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { ok: false, reason: 'GIF not allowed' };
  }

  return { ok: false, reason: 'Unsupported image format (only JPEG / PNG / WebP)' };
}

module.exports = { detect };
