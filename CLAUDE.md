# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Known cleanups (fix before launch)

- **`server.js` lines ~57 and ~62 contain editorial cruft**: a stray `credentials: true` outside any object, and a garbled mid-line `lease try again...` fragment from a bad paste. They currently sit inside comment context so they don't break the server, but they're easy to break with a careless edit. Clean up when you next touch this file.
- **Inline endpoints in `server.js` overlap with `routes/user.js`**: `PATCH /api/user/profile` and `GET /api/user/seller-status` are defined inline and registered before the user router. Consolidate into `routes/user.js` and remove from `server.js`.
- **Duplicate `outfitd.co` entry in the CORS allowlist** (lines 14 and 16). Harmless dup — remove on cleanup.
- **`requireAuth` is duplicated across route files** with subtly different behavior. Consolidate into a single shared middleware (the `routes/seller.js` version is the canonical one — see Auth section below).
## Terminology and compliance

These rules are enforced in the frontend today; backend code (especially error strings, schema names, new endpoints) must not contradict them.

- **"Style Points"** is the user-facing name of the in-app currency. Backend column: `op_balance`. The companion frontend reads `op_balance` into `S.user.stylePoints` and writes `currency: 'op_balance'` to `/api/wallet/award` and `/api/wallet/deduct` for all gameplay deductions/awards. **"Cash Back" is deprecated branding** — don't introduce it in new strings, schemas, or column comments. The frontend completed a `cashback`/`cashOP` → `stylePoints` rename pass; reintroducing the old terminology in API responses, error messages, or column names would force the frontend to re-add legacy aliases.
- **"Store Credits"** (`store_credits` column) is the redemption target. `routes/wallet.js POST /api/wallet/redeem` converts Style Points → Store Credits at 100:1. Frontend reads `store_credits` into `S.user.storeCredits`. Keep these as distinct columns; do not collapse.
- **Age gates** (enforced in frontend, backend should not contradict):
  - 13+ to use the app at all
  - 18+ to be a seller (seller terms-of-service requires it)
  - 18+ to participate in Style Points wagers or paid tournaments
- **State geo-blocks** (enforced in frontend): Style Points wagers and tournament entry fees are blocked for users in **UT, HI, WA**. Any backend endpoint that creates a wager or charges a tournament entry fee should treat this as defense-in-depth and re-validate, since client-side checks alone are bypassable.

## What this repo is

This is the **API server only** for Outfitd, a marketplace + social + gamification (battles/tournaments/leaderboard) product. The frontend is a single large static HTML file deployed separately at `outfitd.co`; this server is deployed at `outfitd-server.onrender.com`. There is **no `express.static` and no `sendFile`** in `server.js` — HTML files committed to this repo (`index.html`, `public/index.html`, `website30.html`) are stale snapshots, not the live frontend. Edits to those files do not reach production.

## Commands

There is no test runner, linter, or build step. The only runtime command is:

```bash
node server.js          # starts on PORT (default 3001)
```

`package.json`'s `test` script is the npm placeholder (`exit 1`). Don't add a test framework unless asked.

The `.env` keys this repo expects: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PORT`, `FRONTEND_URL`. Additional keys referenced in routes: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_INSIDER_PRICE_ID`, `STRIPE_LEGEND_PRICE_ID`, `GOOGLE_CLIENT_ID`, `LOGTAIL_TOKEN`, `SENTRY_DSN`, `NODE_ENV`.

## Deployment

- **Backend (this repo)**: auto-deploys to **Render** on push to `main`. The live URL is `https://outfitd-server.onrender.com`. There is no `render.yaml` in the repo — deploy config lives in the Render dashboard.
- **Frontend (`outfitd.co`)**: served through **Cloudflare** (response headers show only `server: cloudflare` and `cf-ray: …`, with no `x-vercel-id` / `x-nf-request-id` / `x-github-request-id` / `via` header — so there is no Vercel/Netlify/GitHub-Pages origin behind the proxy). Frontend source repo is `github.com/wkim08072004/outfitd` (locally checked out at `~/outfitd-frontend/`), a single-file static-HTML repo with no in-repo deploy config.
- **Frontend deploy mechanism is still TBD.** The natural assumption — Cloudflare Pages bound to the GitHub repo — has **not** been confirmed: a check of the Cloudflare dashboard under `wkim08072004@gmail.com` showed no projects in *Workers & Pages*. So the deploy is configured under a different Cloudflare account, via Workers/R2/a Cloudflare-fronted external origin, or by some other path not yet identified. **Do not assume Cloudflare Pages** when reasoning about how a frontend change reaches production. Update this section once the actual deploy path is identified.

## Architecture you must understand before editing

### Middleware ordering in `server.js` is load-bearing

The order of `app.use(...)` calls matters and several specific orderings are intentional:

1. **`/api/webhooks` is mounted BEFORE `express.json()`.** Stripe webhooks need the raw body for signature verification (`express.raw({ type: 'application/json' })`). Moving `app.use('/api/webhooks', ...)` after the JSON parser will silently break webhook signatures.
2. **Several routers are mounted BEFORE `guestSessionMiddleware`** (`/api/upload`, `/api/payments`, `/api/paypal`, `/api/seller-invite`, `/api/seller`, `/api/stripe-connect`). They bypass guest-session counting/limits by design. Don't reorder without understanding why.
3. **`PATCH /api/user/profile` and `GET /api/user/seller-status` are defined inline in `server.js`** and shadow / supplement `routes/user.js`. The inline `PATCH /api/user/profile` is registered *before* `app.use('/api/user', require('./routes/user'))`, so it wins. If you change profile-update behavior, check both places. (See Known cleanups.)

### Auth: three-layer fallback, role read fresh on each request

Almost every protected route accepts auth in this order:

1. `Authorization: Bearer <jwt>` header (works cross-domain; preferred for API clients on outfitd.co)
2. `token` httpOnly cookie (set by `routes/auth.js#issueTokens`, `SameSite=None; Secure`)
3. (in a few inline endpoints only) email body fallback

**`requireAuth` is duplicated across route files** with subtly different behavior. The canonical pattern lives in `routes/seller.js`: it verifies the JWT, then re-fetches `role` from the `users` table on every request so that role promotions (e.g., user → seller) take effect immediately without requiring re-login. The JWT may carry a stale or absent `role`. When adding new role-gated routes, copy the seller.js pattern, not the simpler one in `routes/upload.js`.

JWTs are signed with `JWT_SECRET` (7d access) and `JWT_REFRESH_SECRET` (30d refresh).

### Admin checks have a hardcoded handle bypass

`routes/seller.js` identifies admins by `role === 'admin'` **or** by a specific hardcoded user handle. If you change admin gating, search this file for the handle-based check before assuming role is the only signal.

### Supabase client: three coexisting patterns

The same Supabase service-role client is constructed in three different places. They're functionally equivalent but you'll see all three:

- `lib/supabase.js` — module singleton, imported as `require('../lib/supabase')`
- `req.app.locals.supabase` — set in `server.js` and used by inline endpoints
- `createClient(...)` called directly inside route files (`routes/seller.js`, `routes/upload.js`, etc.)

Prefer `lib/supabase.js` for new code. The service key bypasses RLS, so all access control happens in Express middleware/route logic — there is no Postgres-side auth fallback.

### Guest sessions

`middleware/guestSession.js` keeps a **process-local in-memory Map** of guest sessions (30-min TTL, 20 page-view limit, swept every 10 min). Two consequences:

- Sessions don't survive server restarts and don't share across instances. If this is ever horizontally scaled, this middleware needs replacing with Redis or similar.
- The `BLOCKED_ROUTES` list inside the middleware is a hardcoded denylist of authenticated-only paths. When adding a new auth-required route prefix, add it here too (or mount before this middleware, like the seller/payments routers do).

### CORS + cookies

Allowed origins are hardcoded in `server.js`: `outfitd.co`, `www.outfitd.co`, `localhost:5500`, `127.0.0.1:5500`. Credentials are enabled, so all auth cookies use `SameSite=None; Secure`. Browser frontends must set `credentials: 'include'` and same-origin won't work in dev unless the dev server runs on port 5500.

### Observability

- **Logtail** is initialized only if `LOGTAIL_TOKEN` is set, exposed at `app.locals.logtail`. Routes that log do so defensively (`logtail?.info(...)`).
- **Sentry** is wired but fully commented out at top of `server.js` and again at the error handler. Don't assume Sentry is capturing anything in production.

### Payments surface

Three independent payment integrations live side-by-side:
- **Stripe** for subscriptions (`routes/subscriptions.js`, `routes/payments.js`, webhook in `routes/webhooks.js` flips `users.subscription` between `free` / `insider` / `legend` based on `STRIPE_INSIDER_PRICE_ID` / `STRIPE_LEGEND_PRICE_ID`).
- **Stripe Connect** for seller payouts (`routes/stripe-connect.js`).
- **PayPal** as an alternate buyer flow (`routes/paypal.js`).

Webhook signatures: when `STRIPE_WEBHOOK_SECRET` is unset, the webhook handler accepts unsigned events (dev mode). Don't rely on this in production.

## Editing conventions specific to this codebase

- The `users.role` enum in use: `'user' | 'seller' | 'admin'`. `requireSeller` accepts both `seller` and `admin`.
- Photo/listing columns can come back in multiple shapes (string, JSON array, Postgres text array). Recent commits added tolerance for this; copy the existing parsing patterns rather than assuming one shape.
- Image uploads go through `/api/upload` which writes base64 → Supabase Storage `images` bucket. The shop feed endpoint deliberately strips base64 image fields to avoid Render gateway timeouts — don't re-add base64 to list responses.
