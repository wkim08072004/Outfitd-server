# Image moderation pipeline — what's real, what's stubbed

This module is **Phase 1** of the moderation spec. The full spec assumes
AWS Rekognition + Textract, OpenAI moderation, PhotoDNA, Resend, and an
NCMEC ESP registration. We have **none** of those today, so this Phase 1
ships:

- Real magic-byte image-type sniffing (`sniff.js`)
- Real SHA-256 hashing + `banned_image_hashes` block list
- Real Anthropic vision classifier (already in the repo, now lifted into
  `classify()` so the upload route uses it server-side)
- Real audit log to `moderation_results`
- Real soft-flag queue in `flagged_uploads` with admin review endpoints
- Skeleton CSAM escalation that writes to `csam_reports` and freezes
  the uploader account when a classifier reason mentions "minor" + a
  sexual category. **No PhotoDNA. No NCMEC filing.**

Everything else is a clearly-labeled stub.

## What runs today

| Step                     | Status      | Notes                                                                                           |
|--------------------------|-------------|-------------------------------------------------------------------------------------------------|
| Magic-byte sniff         | Real        | JPEG / PNG / WebP only. GIF + animated PNG/WebP rejected.                                       |
| 10 MB size cap           | Real        | Enforced in upload route.                                                                       |
| EXIF strip + re-encode   | **Stubbed** | Requires `sharp`. See "Why no sharp" below.                                                     |
| 8000×8000 dimension cap  | **Stubbed** | Same — needs `sharp` to read dimensions before decode.                                          |
| SHA-256 dedupe + ban list| Real        | `node:crypto`, no deps.                                                                         |
| Perceptual hash (pHash)  | **Stubbed** | Requires `sharp` + `sharp-phash`. Without it we only catch byte-identical re-uploads.           |
| AWS Rekognition          | **Stubbed** | `classifyRekognition()` returns `null` until `AWS_ACCESS_KEY_ID` is set and the function is filled in. |
| AWS Textract / OCR       | **Stubbed** | Same env trigger. Anthropic vision already reads in-image text as fallback.                     |
| OpenAI text moderation   | **Stubbed** | Triggered by `OPENAI_API_KEY`; not wired today.                                                 |
| Anthropic vision         | Real        | `claude-haiku-4-5`. Failure mode → soft-flag, never silent pass.                                 |
| Audit log                | Real        | Every decision lands in `moderation_results` plus a structured `console.log`.                   |
| Soft-flag queue          | Real        | `flagged_uploads`. Admin endpoints under `/api/admin/moderation/*`.                              |
| CSAM detection           | **Defense-in-depth only** | No PhotoDNA. We only react to classifier-language matches, which is unreliable.    |
| NCMEC reporting          | **Manual**  | Required by 18 U.S.C. § 2258A(a)(1) once we are a registered ESP. Today: alert + manual filing. |
| Resend email alerts      | **Stubbed** | `csam_reports` row written; no email sent. Set `RESEND_API_KEY` and add the call.               |
| Sentry                   | **Stubbed** | Already commented out in `server.js`. Restore it when you have the DSN.                          |
| Logtail structured logs  | Real        | We emit JSON lines from `recordDecision` — Logtail picks them up if `LOGTAIL_TOKEN` is set.      |
| Circuit breaker          | **Skipped** | Single classifier today; not worth the complexity. Add when there are 2+ external calls.        |
| Test fixture suite       | **Stubbed** | No safe-set / known-bad set checked in. See "Tests" below.                                       |

## Behaviour today (so a reader can trace a request)

```
upload.js POST /api/upload
  ├─ require auth
  ├─ parse base64 → buffer
  ├─ size cap (10 MB)
  ├─ sniff.detect(buffer)                     ← magic bytes, animated check
  ├─ moderation.sha256(buffer)
  ├─ moderation.isBanned(sha)                 ← exact-match block list
  │     → if banned: 403 generic policy error
  ├─ moderation.classify({buffer, mediaType}) ← Anthropic today; AWS later
  │     → action ∈ { pass | soft_flag | reject }
  ├─ if reject:
  │     ├─ banHash(sha, …)
  │     ├─ recordDecision(…)
  │     ├─ maybeEscalateCsam(…)               ← CSAM defense-in-depth
  │     └─ 403 generic policy error
  ├─ supabase.storage.upload(…)
  ├─ recordHash(…)
  ├─ recordDecision(…)
  ├─ if soft_flag: queueReview(…)
  └─ return { url, queuedForReview? }
```

Failure mode for any classifier exception or upstream non-OK is
`soft_flag`, never `pass`. Spec §7.

## Why no `sharp`

`sharp` is the standard Node.js image-processing library and is what we'd
use for EXIF stripping, re-encoding, dimension reads, and as a base for
perceptual hashing. It has native bindings (libvips) which usually
install fine on Render but have historically been a deploy-breaker for
this project (see the earlier moderation rollback). We're deferring it
until we have a clean Render build hook for it. The right unblock is to
add `sharp` to `package.json`, verify on a staging Render service, then
flip the EXIF strip + dimension cap on. Until then, EXIF data IS being
re-uploaded to Supabase Storage. Treat this as a **known privacy gap**.

## Soft-flag handling

The spec wants soft-flagged uploads stored privately and not shown
publicly until admin approval. Today they're stored publicly (same path
as approved uploads) and queued for review. The reason: making them
private requires the frontend to handle a `pending` state in every
upload consumer (avatars, banners, posts, listings). That's Phase 2.

The trade-off: a flagged image is publicly viewable for the few minutes
until you approve/reject it. Mitigation: classifier failures default to
soft-flag, so the queue will fill up if the API has problems — work it
promptly.

## Admin

`/api/admin/moderation/queue` — pending items, newest first.
`/api/admin/moderation/:id/approve` — admin approves; row marked.
`/api/admin/moderation/:id/reject` — admin rejects; sha256 added to
`banned_image_hashes` so re-uploads are blocked at step 1.

All require an admin JWT (cookie set by `/api/admin/login`,
`role: 'admin'`).

## Env vars to add when you're ready

Document these in Render's dashboard — never commit values.

| Var                       | Enables                                  |
|---------------------------|------------------------------------------|
| `AWS_ACCESS_KEY_ID`       | Triggers Rekognition + Textract path.    |
| `AWS_SECRET_ACCESS_KEY`   | Same.                                    |
| `AWS_REGION`              | e.g. `us-west-2`.                        |
| `OPENAI_API_KEY`          | Triggers OpenAI moderation endpoint.     |
| `RESEND_API_KEY`          | Sends CSAM/admin alert emails.           |
| `MODERATION_ADMIN_EMAIL`  | Recipient for the above.                 |
| `SENTRY_DSN`              | Restores Sentry capture in `server.js`.  |

## Migrations

`migrations/20260502_moderation.sql` creates the five tables. After
running it in the Supabase SQL Editor, run:

```sql
NOTIFY pgrst, 'reload schema';
```

so PostgREST sees the new tables. (Same gotcha that bit us on the
posts-table column issue.)

## Tests

Spec §9 wants smoke tests with a known-safe set, a nudity test image,
a violence test image, and a text-overlay image, plus an EXIF-strip
verification and a banned-hash-blocks-reupload check.

Not checked in. We don't ship test images in the repo. The safe path
to add these:

1. Create a `tests/fixtures/` directory locally, **gitignored**.
2. Pull from a recognised research test set (e.g. NPDI for nudity).
3. Wire a simple node script that POSTs each image to `/api/upload`
   against a local server with the same env, and asserts the resulting
   `action` from `moderation_results`.
4. EXIF-strip test: gated on `sharp` being added.

When that's in place, list it in `LAUNCH_CHECKLIST.md`.

## Legal notes

- 18 U.S.C. § 2258A obligates ESPs to report apparent CSAM to NCMEC's
  CyberTipline within a reasonable time. We are not yet a registered
  ESP. Until we are, the `csam_reports` table is a manual review queue,
  not an automated reporting pipeline. **Do not assume any automated
  filing is happening.**
- PhotoDNA access requires a Microsoft application + approval. Apply at
  the Microsoft PhotoDNA Cloud Service portal.
- Even with PhotoDNA in place, do not store CSAM material yourself —
  the lawful pattern is hash-match, do-not-publish, report, delete.
