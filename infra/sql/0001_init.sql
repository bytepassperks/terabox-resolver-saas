-- terabox-resolver-saas: initial schema
-- Apply with: psql "$DATABASE_URL" -f infra/sql/0001_init.sql
-- Idempotent — safe to re-run on existing databases.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ─────────────────────────────────────────────────────────────────────────────
-- users: one row per Telegram account.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id             BIGINT       NOT NULL UNIQUE,
  credits                 INTEGER      NOT NULL DEFAULT 0 CHECK (credits >= 0),
  plan                    TEXT         NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free','starter','basic','pro','power','ultra')),
  plan_expires_at         TIMESTAMPTZ,
  lifetime_credits_used   BIGINT       NOT NULL DEFAULT 0,
  is_blocked              BOOLEAN      NOT NULL DEFAULT FALSE,
  last_free_grant_date    DATE,
  last_active_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_last_active_idx ON users (last_active_at DESC);
CREATE INDEX IF NOT EXISTS users_plan_idx        ON users (plan);

-- ─────────────────────────────────────────────────────────────────────────────
-- credit_mutations: append-only audit log for every balance change.
-- Idempotency enforced via a UNIQUE constraint on idempotency_key.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_mutations (
  id                 BIGSERIAL    PRIMARY KEY,
  user_id            UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta              INTEGER      NOT NULL,
  source             TEXT         NOT NULL
    CHECK (source IN (
      'resolve_success','resolve_refund','stars_payment',
      'admin_adjustment','daily_free','redeem_code','bonus'
    )),
  reason             TEXT,
  admin_id           TEXT,
  idempotency_key    TEXT         NOT NULL UNIQUE,
  metadata           JSONB,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credit_mutations_user_idx   ON credit_mutations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_mutations_source_idx ON credit_mutations (source, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- resolve_logs: one row per resolve attempt (success or error). Used for
-- analytics and for reconciliation when refund flows fire.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resolve_logs (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         REFERENCES users(id) ON DELETE SET NULL,
  provider        TEXT         NOT NULL,
  share_id        TEXT,
  status          TEXT         NOT NULL CHECK (status IN ('success','cache_hit','error')),
  error_code      TEXT,
  duration_ms     INTEGER,
  credits_used    INTEGER      NOT NULL DEFAULT 0,
  request_id      TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resolve_logs_user_idx      ON resolve_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resolve_logs_provider_idx  ON resolve_logs (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS resolve_logs_status_idx    ON resolve_logs (status, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- stars_events: idempotency store for Telegram Stars webhook deliveries.
-- telegram_charge_id is the canonical dedup key Telegram provides.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stars_events (
  telegram_charge_id         TEXT         PRIMARY KEY,
  provider_payment_charge_id TEXT,
  telegram_user_id           BIGINT       NOT NULL,
  amount_stars               INTEGER      NOT NULL CHECK (amount_stars >= 0),
  payload                    JSONB,
  processed                  BOOLEAN      NOT NULL DEFAULT FALSE,
  received_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stars_events_user_idx ON stars_events (telegram_user_id, received_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- metadata_index: durable L2 cache of resolve results, keyed by (provider, share_id).
-- Warm-cache cron picks the top-N rows by popularity_score.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metadata_index (
  provider          TEXT         NOT NULL,
  share_id          TEXT         NOT NULL,
  payload           JSONB        NOT NULL,
  resolve_count     BIGINT       NOT NULL DEFAULT 0,
  popularity_score  INTEGER      NOT NULL DEFAULT 0,
  last_checked      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, share_id)
);

CREATE INDEX IF NOT EXISTS metadata_index_popularity_idx
  ON metadata_index (popularity_score DESC, last_checked DESC);
CREATE INDEX IF NOT EXISTS metadata_index_last_checked_idx
  ON metadata_index (last_checked DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- admins: optional — who may issue JWTs against the admin-api.
-- Roles align with packages/shared-types/src/admin.ts (support < admin < super_admin).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id  BIGINT       UNIQUE,
  email        CITEXT,
  role         TEXT         NOT NULL CHECK (role IN ('support','admin','super_admin')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMIT;
