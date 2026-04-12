// === Sentry Error Tracking (must be first) ===
const Sentry = require("@sentry/node");
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "development",
  tracesSampleRate: 0.2,
});

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const { Logtail } = require("@logtail/node");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://outfitd.co");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
res.header(
  "Access-Control-Allow-Headers",
  req.headers["access-control-request-headers"] || "*"
);

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});
app.set('trust proxy', 1);
// Shared services
const logtail = process.env.LOGTAIL_TOKEN ? new Logtail(process.env.LOGTAIL_TOKEN) : null;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
app.locals.logtail = logtail;
app.locals.supabase = supabase;


// Security headers
app.use(helmet());

// Only your frontend can call this API
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5500',
  credentials: true
}));

// General rate limit
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many login attempts. Please try again in 15 minutes.' } }));
// Tighter limit on auth routes
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));

// Parse cookies and JSON
app.use(cookieParser());
app.use('/api/webhooks', require('./routes/webhooks'));
app.use(express.json({ limit: '50mb' }));
app.use('/api/upload', require('./routes/upload'));
// Guest session limits
const { guestSessionMiddleware } = require("./middleware/guestSession");
app.use("/api/payments", require("./routes/payments"));
app.use("/api/paypal", require("./routes/paypal"));
app.use("/api/seller-invite", require("./routes/seller-invite"));
app.use("/api/stripe-connect", require("./routes/stripe-connect"));
app.use("/api", guestSessionMiddleware);


// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/battles', require('./routes/battles'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/leaderboard', require('./routes/leaderboard'));

// Profile sync (cross-browser/device) — must be before the user router
app.patch('/api/user/profile', async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const { email, display_name, handle, bio, avatar_url } = req.body;

    // Auth: check Authorization header first (works cross-domain), then cookie, then email fallback
    let userId;
    const jwt = require('jsonwebtoken');
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {}
    }
    if (!userId) {
      const token = req.cookies?.token;
      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          userId = decoded.userId;
        } catch (e) {}
      }
    }
    if (!userId && email) {
      const { data: user } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
      if (user) userId = user.id;
    }
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    if (handle !== undefined) {
      const clean = handle.toLowerCase().replace('@', '').replace(/[^a-z0-9_]/g, '');
      if (clean.length < 3 || clean.length > 20) return res.status(400).json({ error: 'Handle must be 3-20 characters' });
      const reserved = ['admin','outfitd','support','moderator','system','official','staff','mod'];
      if (reserved.some(r => clean.includes(r))) return res.status(400).json({ error: 'That username is reserved' });
      const { data: existing } = await supabase.from('users').select('id').eq('handle', clean).neq('id', userId).maybeSingle();
      if (existing) return res.status(409).json({ error: 'Username already taken' });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (display_name !== undefined) updates.display_name = display_name.slice(0, 50);
    if (handle !== undefined) updates.handle = handle.toLowerCase().replace('@', '').replace(/[^a-z0-9_]/g, '');
    if (bio !== undefined) updates.bio = bio.slice(0, 160);
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (req.body.banner_bg !== undefined) updates.banner_bg = req.body.banner_bg;
    if (req.body.banner_photo !== undefined) updates.banner_photo = req.body.banner_photo;
    if (req.body.role === 'seller') updates.role = 'seller';

    const { error } = await supabase.from('users').update(updates).eq('id', userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.use('/api/user', require('./routes/user'));
app.use('/api/seller', require('./routes/seller'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/verify', require('./routes/verify'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/kyc', require('./routes/kyc'));
app.use('/api/redeem', require('./routes/redeem'));
app.use('/api/notifications', require('./routes/notifications'));

// Seller status check (cross-browser sync)
app.get('/api/user/seller-status', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    let userId;
    // Check Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {}
    }
    // Fall back to cookie
    if (!userId) {
      const token = req.cookies?.token;
      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          userId = decoded.userId;
        } catch (e) {}
      }
    }
    if (!userId) return res.json({ is_seller: false });
    const supabase = req.app.locals.supabase;
    const { data: user } = await supabase.from('users').select('role').eq('id', userId).single();
    res.json({ is_seller: !!(user && user.role === 'seller') });
  } catch (err) {
    res.json({ is_seller: false });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/products', require('./routes/products'));
// Sentry error handler (must be after all routes)
Sentry.setupExpressErrorHandler(app);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
app.use((err, req, res, next) => {
  console.error("🔥 SERVER ERROR:", err);

  res.header("Access-Control-Allow-Origin", "https://outfitd.co");
  res.header("Access-Control-Allow-Credentials", "true");

  res.status(500).json({
    error: "Internal Server Error",
    message: err.message
  });
});