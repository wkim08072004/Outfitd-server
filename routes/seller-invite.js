const express = require('express');
const router = express.Router();
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// POST /api/seller-invite/send — email a seller invite code
router.post('/send', async (req, res) => {
  try {
    const { email, code, brand } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Missing email or code' });
    }

    await resend.emails.send({
      from: 'Outfitd <noreply@outfitd.co>',
      to: email,
      subject: '🎉 Your OUTFITD Seller Application Has Been Approved!',
      html: `
        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="font-size: 28px; font-weight: 900; letter-spacing: 2px; margin: 0;">OUTFITD</h1>
          </div>
          <h2 style="font-size: 22px; font-weight: 700; margin-bottom: 10px;">Congratulations${brand ? ', ' + brand : ''}! 🎉</h2>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            Your seller application has been <strong>approved</strong>. Welcome to the OUTFITD marketplace!
          </p>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            Use the invite code below to complete your seller registration at <a href="https://outfitd.co" style="color: #c9184a; text-decoration: none; font-weight: 600;">outfitd.co</a>:
          </p>
          <div style="background: #fff0f3; border: 2px dashed #c9184a; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <div style="font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 4px; color: #c9184a;">${code}</div>
            <div style="font-size: 12px; color: #666; margin-top: 8px;">One-time seller invite code for ${email}</div>
          </div>
          <div style="background: #f8f8f8; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 13px; color: #555; line-height: 1.6;">
            <strong>How to get started:</strong><br>
            1. Go to <a href="https://outfitd.co" style="color: #c9184a;">outfitd.co</a> and sign up or log in<br>
            2. Click "Sell on OUTFITD" or go to your account settings<br>
            3. Enter this invite code along with your approved email<br>
            4. Start listing your products!
          </div>
          <p style="font-size: 12px; color: #999; margin-top: 30px; text-align: center;">
            ⚠️ This code can only be used once and expires when you sign up.<br>
            If you didn't apply to sell on OUTFITD, please ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="font-size: 11px; color: #bbb; text-align: center;">
            © ${new Date().getFullYear()} Outfitd, LLC. All rights reserved.
          </p>
        </div>
      `
    });

    res.json({ sent: true });
  } catch (err) {
    console.error('Seller invite email error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
