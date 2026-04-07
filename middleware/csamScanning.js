const axios = require("axios");
const crypto = require("crypto");

async function scanWithPhotoDNA(imageBuffer) {
  if (process.env.CSAM_SCANNING_ENABLED !== "true" || !process.env.PHOTODNA_API_KEY) {
    return { isMatch: false, scanSkipped: true };
  }
  try {
    const response = await axios.post(
      "https://api.microsoftmoderator.com/photodna/v1.0/Match",
      { DataRepresentation: "inline", Value: imageBuffer.toString("base64") },
      { headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": process.env.PHOTODNA_API_KEY }, timeout: 30000 }
    );
    return { isMatch: response.data.IsMatch === true, trackingId: response.data.TrackingId };
  } catch (err) {
    return { isMatch: false, scanSkipped: true, reason: "api_error", error: err.message };
  }
}

async function csamScanMiddleware(req, res, next) {
  if (!req.file) return next();
  const imageTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!imageTypes.includes(req.file.mimetype)) return next();

  const userId = req.user?.id || "anonymous";
  const { supabase, logtail } = req.app.locals;

  try {
    const result = await scanWithPhotoDNA(req.file.buffer);

    if (result.isMatch) {
      const quarantineId = crypto.randomUUID();
      await supabase.storage.from("quarantined-content").upload(`${quarantineId}.bin`, req.file.buffer, { contentType: req.file.mimetype });
      await supabase.from("csam_incidents").insert({
        id: quarantineId, user_id: userId, quarantine_path: `${quarantineId}.bin`,
        file_hash: crypto.createHash("sha256").update(req.file.buffer).digest("hex"),
        file_size: req.file.size, file_type: req.file.mimetype, ip_address: req.ip,
        user_agent: req.get("user-agent"), reported_to_ncmec: false
      });
      await supabase.auth.admin.updateUserById(userId, { banned: true });
      logtail?.error("CSAM MATCH DETECTED", { userId, quarantineId });
      return res.status(400).json({ error: "This image cannot be uploaded. Your account has been suspended.", code: "CONTENT_VIOLATION" });
    }

    if (result.scanSkipped) {
      const moderationId = crypto.randomUUID();
      await supabase.from("content_moderation_queue").insert({
        id: moderationId, user_id: userId,
        file_hash: crypto.createHash("sha256").update(req.file.buffer).digest("hex"),
        file_size: req.file.size, file_type: req.file.mimetype,
        scan_skip_reason: result.reason || "scanning_disabled", status: "pending_review"
      });
      req.moderationId = moderationId;
      req.imageModerated = false;
      return next();
    }

    req.imageModerated = true;
    next();
  } catch (err) {
    logtail?.error("CSAM scan error", { userId, error: err.message });
    return res.status(500).json({ error: "Image processing failed", code: "SCAN_ERROR" });
  }
}

module.exports = { csamScanMiddleware, scanWithPhotoDNA };
