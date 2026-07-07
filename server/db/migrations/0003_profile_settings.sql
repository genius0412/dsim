-- Per-account settings sync: store each user's full GameSettings blob so their
-- robot/controls/assists/audio follow their account across devices. Client-shaped
-- JSON, validated client-side on load (coerceSettings). Nullable — a fresh profile
-- has none until the client first pushes.
alter table profiles add column if not exists settings jsonb;
