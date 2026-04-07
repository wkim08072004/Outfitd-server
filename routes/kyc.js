const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const jwt = require("jsonwebtoken");

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: "Invalid token" }); }
}

function validateAge(dob) {
  const d = new Date(dob), today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  if (today.getMonth() < d.getMonth() || (today.getMonth() === d.getMonth() && today.getDate() < d.getDate())) age--;
  return age >= 18;
}

router.post("/submit", auth, async (req, res) => {
  const { supabase, logtail } = req.app.locals;
  const userId = req.user.userId || req.user.id;
  try {
    const { data: existing } = await supabase.from("kyc_submissions").select("id, status").eq("user_id", userId).in("status", ["pending", "approved"]).limit(1);
    if (existing?.length > 0) {
      return res.status(400).json({ error: existing[0].status === "approved" ? "Already verified" : "Verification pending", code: "KYC_EXISTS" });
    }
    const { legalFirstName, legalLastName, dateOfBirth, addressLine1, addressLine2, city, state, zip, idDocumentType } = req.body;
    const errors = [];
    if (!legalFirstName?.trim()) errors.push("First name required");
    if (!legalLastName?.trim()) errors.push("Last name required");
    if (!dateOfBirth || !validateAge(dateOfBirth)) errors.push("Must be 18+");
    if (!addressLine1?.trim()) errors.push("Address required");
    if (!city?.trim()) errors.push("City required");
    if (!state?.trim()) errors.push("State required");
    if (!zip?.trim() || !/^\d{5}(-\d{4})?$/.test(zip)) errors.push("Valid ZIP required");
    if (!["drivers_license", "passport", "state_id"].includes(idDocumentType)) errors.push("Valid ID type required");
    if (errors.length > 0) return res.status(400).json({ error: "Validation failed", details: errors });
    if (!req.file) return res.status(400).json({ error: "ID document photo required" });
    if (!["image/jpeg", "image/png"].includes(req.file.mimetype)) return res.status(400).json({ error: "JPEG or PNG only" });
    if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ error: "Max 10MB" });

    const ext = req.file.mimetype === "image/png" ? "png" : "jpg";
    const fileName = `${userId}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("kyc-documents").upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadErr) return res.status(500).json({ error: "Upload failed" });

    const { data: sub, error: insertErr } = await supabase.from("kyc_submissions").insert({
      user_id: userId, legal_first_name: legalFirstName.trim(), legal_last_name: legalLastName.trim(),
      date_of_birth: dateOfBirth, address_line1: addressLine1.trim(), address_line2: addressLine2?.trim() || null,
      city: city.trim(), state: state.toUpperCase(), zip: zip.trim(),
      id_document_type: idDocumentType, id_document_url: fileName, status: "pending"
    }).select("id, status").single();
    if (insertErr) return res.status(500).json({ error: "Submission failed" });

    logtail?.info("KYC submitted", { userId, submissionId: sub.id });
    res.status(201).json({ success: true, submissionId: sub.id, status: "pending" });
  } catch (err) {
    logtail?.error("KYC error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/status", auth, async (req, res) => {
  const { supabase } = req.app.locals;
  const userId = req.user.userId || req.user.id;
  const { data } = await supabase.from("kyc_submissions").select("id, status, rejection_reason, created_at, reviewed_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).single();
  if (!data) return res.json({ verified: false, status: "not_submitted" });
  res.json({ verified: data.status === "approved", status: data.status, rejectionReason: data.rejection_reason });
});

router.get("/admin/pending", auth, async (req, res) => {
  const { supabase } = req.app.locals;
  const { data } = await supabase.from("kyc_submissions").select("*").eq("status", "pending").order("created_at", { ascending: true });
  res.json({ submissions: data || [], count: (data || []).length });
});

router.post("/admin/review/:id", auth, async (req, res) => {
  const { supabase, logtail } = req.app.locals;
  const { decision, rejectionReason } = req.body;
  if (!["approved", "rejected"].includes(decision)) return res.status(400).json({ error: "Invalid decision" });
  if (decision === "rejected" && !rejectionReason) return res.status(400).json({ error: "Reason required" });

  const { data, error } = await supabase.from("kyc_submissions").update({
    status: decision, rejection_reason: decision === "rejected" ? rejectionReason : null,
    reviewed_by: req.user.userId || req.user.id, reviewed_at: new Date().toISOString()
  }).eq("id", req.params.id).eq("status", "pending").select("user_id").single();

  if (error || !data) return res.status(404).json({ error: "Not found or already reviewed" });
  if (decision === "approved") await supabase.from("users").update({ kyc_verified: true }).eq("id", data.user_id);
  logtail?.info("KYC reviewed", { submissionId: req.params.id, decision });
  res.json({ success: true, decision });
});

module.exports = router;
