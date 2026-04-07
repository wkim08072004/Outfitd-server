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
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Tighter limit on auth routes
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));

// Parse cookies and JSON
app.use(cookieParser());
app.use('/api/webhooks', require('./routes/webhooks'));
app.use(express.json({ limit: '2mb' }));

// Guest session limits
const { guestSessionMiddleware } = require("./middleware/guestSession");
app.use("/api", guestSessionMiddleware);


// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/battles', require('./routes/battles'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
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
// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Sentry error handler (must be after all routes)
Sentry.setupExpressErrorHandler(app);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
