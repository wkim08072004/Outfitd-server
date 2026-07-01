-- 18+ policy: users.date_of_birth is required at signup going forward.
-- Existing rows (signed up under the old 13+ policy) may be NULL and are
-- grandfathered; new inserts must supply a valid DOB with age >= 18. The
-- app-layer age check lives in routes/auth.js (validateAdultDob).

ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

NOTIFY pgrst, 'reload schema';
