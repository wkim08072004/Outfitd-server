const crypto = require("crypto");
const guestSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of guestSessions) {
    if (now - session.createdAt > 30 * 60 * 1000) guestSessions.delete(id);
  }
}, 10 * 60 * 1000);

const BLOCKED_ROUTES = [
  "/api/orders", "/api/wallet", "/api/wager", "/api/battles/create",
  "/api/battles/accept", "/api/posts/create", "/api/posts/like",
  "/api/posts/comment", "/api/seller", "/api/referral", "/api/redeem",
  "/api/subscriptions", "/api/settings"
];

function guestSessionMiddleware(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith("/api/auth/") || req.path === "/health") return next();

  const isBlocked = BLOCKED_ROUTES.some(r => req.path.startsWith(r));
  if (isBlocked) {
    return res.status(401).json({ error: "Authentication required", code: "GUEST_BLOCKED_ROUTE" });
  }

  let guestId = req.cookies?.outfitd_guest;
  let session;

  if (guestId && guestSessions.has(guestId)) {
    session = guestSessions.get(guestId);
  } else {
    guestId = crypto.randomUUID();
    session = { id: guestId, createdAt: Date.now(), pageViews: 0 };
    guestSessions.set(guestId, session);
    res.cookie("outfitd_guest", guestId, {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "lax", maxAge: 30 * 60 * 1000
    });
  }

  if (Date.now() - session.createdAt > 30 * 60 * 1000) {
    guestSessions.delete(guestId);
    res.clearCookie("outfitd_guest");
    return res.status(401).json({ error: "Guest session expired", code: "GUEST_SESSION_EXPIRED" });
  }

  session.pageViews++;
  if (session.pageViews > 20) {
    return res.status(401).json({ error: "Guest limit reached", code: "GUEST_VIEW_LIMIT" });
  }

  req.guest = { id: guestId, pageViews: session.pageViews, remainingViews: 20 - session.pageViews };
  next();
}

module.exports = { guestSessionMiddleware };
