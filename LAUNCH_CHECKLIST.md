# Launch Checklist

Items required before opening sign-ups beyond the closed test group.

## Moderation pipeline (added 2026-05-02)

See `lib/moderation/README.md` for the per-component status. This list is
the launch-blocker subset.

### Must do before launch

- [ ] Run `migrations/20260502_moderation.sql` in Supabase SQL Editor.
- [ ] Run `NOTIFY pgrst, 'reload schema';` so PostgREST sees the new
      tables (same gotcha that broke posting earlier).
- [ ] Confirm at least one user has `users.role = 'admin'` so the
      `/api/admin/moderation/queue` endpoints are usable.
- [ ] Add `sharp` to `package.json` and re-enable EXIF stripping +
      8000×8000 dimension cap in `routes/upload.js`. The privacy gap
      until then is real (GPS in EXIF).
- [ ] Decide on AWS vs Anthropic-only for v1. If AWS:
      - [ ] Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
            on Render.
      - [ ] Install `@aws-sdk/client-rekognition` and fill in
            `lib/moderation/index.js#classifyRekognition`.
      - [ ] Wire AWS Textract or Rekognition DetectText for
            `classifyText` before relying on text-on-image moderation.
- [ ] Set `OPENAI_API_KEY` on Render OR confirm the Anthropic-only
      classifier path is acceptable for text moderation.
- [ ] Set `RESEND_API_KEY` and `MODERATION_ADMIN_EMAIL` on Render so
      CSAM escalations actually email someone.
- [ ] Restore Sentry: uncomment `Sentry.init` + `setupExpressErrorHandler`
      in `server.js` and set `SENTRY_DSN` on Render.

### Must do before opening posts to anyone outside the test group

- [ ] Apply for PhotoDNA via the Microsoft PhotoDNA Cloud Service
      portal. Lead time is weeks.
- [ ] Register as an Electronic Service Provider with NCMEC so
      CyberTipline reports can be filed. 18 U.S.C. § 2258A(a)(1).
- [ ] Until both above ship, the `csam_reports` table is a manual
      review queue. Whoever owns the alias on `MODERATION_ADMIN_EMAIL`
      must check it daily and file any apparent CSAM with NCMEC by
      hand.

### Should do, not blocking

- [ ] Add a `tests/fixtures/` set (gitignored, pulled from a research
      test set) and a script that POSTs each fixture and asserts the
      `moderation_results.action`.
- [ ] Phase 2: store soft-flagged uploads in a private prefix and have
      the frontend handle a real "pending" UX in posts / listings /
      avatars / banners. Today they're stored publicly until reviewed.
- [ ] Add a perceptual hash (`sharp-phash`) so re-uploads with one
      pixel changed still get caught by the ban list.
