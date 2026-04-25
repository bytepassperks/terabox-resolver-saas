-- terabox-resolver-saas: account pool rotation tables
-- Apply with: psql "$DATABASE_URL" -f infra/sql/0002_account_pool.sql
-- Idempotent — safe to re-run on existing databases.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_accounts: one row per upstream provider account (TeraBox, etc.).
-- Stores session cookies and health metadata for round-robin rotation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_accounts (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT         NOT NULL DEFAULT 'terabox',
  label            TEXT,
  cookie           TEXT         NOT NULL,
  status           TEXT         NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cooldown', 'disabled', 'expired')),
  usage_count      BIGINT       NOT NULL DEFAULT 0,
  success_count    BIGINT       NOT NULL DEFAULT 0,
  failure_count    BIGINT       NOT NULL DEFAULT 0,
  consecutive_failures INTEGER  NOT NULL DEFAULT 0,
  last_used_at     TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_failure_at  TIMESTAMPTZ,
  cooldown_until   TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  added_by         TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS provider_accounts_provider_status_idx
  ON provider_accounts (provider, status, last_used_at ASC NULLS FIRST);

COMMIT;
