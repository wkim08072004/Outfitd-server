const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const router = express.Router();

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
}

async function getPayPalToken() {
  const base = process.env.PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const res = await axios.post(`${base}/v1/oauth2/token`, "grant_type=client_credentials", {
    auth: { username: process.env.PAYPAL_CLIENT_ID, password: process.env.PAYPAL_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  return { token: res.data.access_token, base };
}

router.post("/", auth, async (req, res) => {
  const { supabase, logtail } = req.app.locals;
  if (process.env.PAYOUTS_ENABLED !== "true") return res.status(503).json({ error: "Payouts temporarily disabled" });

  try {
    const userId = req.user.userId || req.user.id;
    const { paypalEmail } = req.body;
    if (!paypalEmail?.includes("@")) return res.status(400).json({ error: "Valid PayPal email required" });

    const { data: user } = await supabase.from("users").select("id, store_credits, kyc_verified, last_payout_at").eq("id", userId).single();
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.kyc_verified) return res.status(403).json({ error: "KYC verification required", code: "KYC_REQUIRED" });

    if (user.last_payout_at) {
      const hours = (Date.now() - new Date(user.last_payout_at).getTime()) / 3600000;
      if (hours < 24) return res.status(429).json({ error: `Wait ${Math.ceil(24 - hours)} hours`, code: "COOLDOWN" });
    }

    const credits = user.store_credits || 0;
    const amountUSD = credits * 0.01;
    if (amountUSD < 10) return res.status(400).json({ error: `Minimum $10. Your balance: $${amountUSD.toFixed(2)}`, code: "BELOW_MINIMUM" });
    if (amountUSD > 500) return res.status(400).json({ error: "Maximum $500 per payout", code: "EXCEEDS_MAX" });

    const payoutId = `PO-${Date.now()}-${userId.substring(0, 8)}`;
    await supabase.from("payouts").insert({ id: payoutId, user_id: userId, amount_usd: amountUSD, store_credits_redeemed: credits, paypal_email: paypalEmail, status: "pending" });

    const { error: deductErr } = await supabase.from("users").update({ store_credits: 0, last_payout_at: new Date().toISOString() }).eq("id", userId).eq("store_credits", credits);
    if (deductErr) {
      await supabase.from("payouts").update({ status: "failed", error_message: "Deduction failed" }).eq("id", payoutId);
      return res.status(500).json({ error: "Please try again" });
    }

    try {
      const { token, base } = await getPayPalToken();
      const ppRes = await axios.post(`${base}/v1/payments/payouts`, {
        sender_batch_header: { sender_batch_id: payoutId, email_subject: "Your Outfitd Store Credit Redemption" },
        items: [{ recipient_type: "EMAIL", amount: { value: amountUSD.toFixed(2), currency: "USD" }, receiver: paypalEmail, sender_item_id: `outfitd-${payoutId}` }]
      }, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

      await supabase.from("payouts").update({ status: "completed", paypal_batch_id: ppRes.data.batch_header?.payout_batch_id }).eq("id", payoutId);
      logtail?.info("Payout completed", { userId, amountUSD, payoutId });
      res.json({ success: true, payoutId, amountUSD, message: `$${amountUSD.toFixed(2)} sent to ${paypalEmail}` });
    } catch (ppErr) {
      await supabase.from("users").update({ store_credits: credits }).eq("id", userId);
      await supabase.from("payouts").update({ status: "failed", error_message: ppErr.message }).eq("id", payoutId);
      logtail?.error("PayPal payout failed — refunded", { userId, error: ppErr.message });
      res.status(502).json({ error: "Payout failed. Credits refunded.", code: "PAYPAL_ERROR" });
    }
  } catch (err) {
    logtail?.error("Redeem error", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/status/:payoutId", auth, async (req, res) => {
  const { supabase } = req.app.locals;
  const userId = req.user.userId || req.user.id;
  const { data } = await supabase.from("payouts").select("id, amount_usd, status, paypal_email, created_at").eq("id", req.params.payoutId).eq("user_id", userId).single();
  if (!data) return res.status(404).json({ error: "Payout not found" });
  res.json(data);
});

module.exports = router;
