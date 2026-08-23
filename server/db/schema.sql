-- invest-buddy schema
-- Money is stored as BIGINT cents everywhere to avoid floating point drift.

DROP TABLE IF EXISTS investment_lines CASCADE;
DROP TABLE IF EXISTS investments CASCADE;
DROP TABLE IF EXISTS sleeves CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;

CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  note           TEXT NOT NULL,
  -- Total CRA contribution room available for this account, in cents.
  -- NULL means "no limit" (non-registered).
  room_limit     BIGINT,
  sort_order     INT  NOT NULL,
  CONSTRAINT room_limit_non_negative CHECK (room_limit IS NULL OR room_limit >= 0)
);

CREATE TABLE sleeves (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tickers        TEXT NOT NULL,
  label          TEXT NOT NULL,
  -- Target weight as a fraction of the TOTAL portfolio, in basis points.
  -- The five sleeves sum to 10000.
  target_bps     INT  NOT NULL,
  -- Current book value of this sleeve, in cents.
  holding_cents  BIGINT NOT NULL DEFAULT 0,
  sort_order     INT  NOT NULL,
  CONSTRAINT target_bps_valid  CHECK (target_bps BETWEEN 0 AND 10000),
  CONSTRAINT holding_non_negative CHECK (holding_cents >= 0)
);

CREATE INDEX sleeves_account_idx ON sleeves (account_id);

CREATE TABLE investments (
  id                SERIAL PRIMARY KEY,
  -- What the user asked to invest.
  requested_cents   BIGINT      NOT NULL,
  -- What actually landed in sleeves after contribution-room capping.
  allocated_cents   BIGINT      NOT NULL,
  -- requested - allocated: blocked by contribution room, left as cash.
  unallocated_cents BIGINT      NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT requested_positive CHECK (requested_cents > 0),
  CONSTRAINT allocation_balances CHECK (allocated_cents + unallocated_cents = requested_cents)
);

CREATE TABLE investment_lines (
  id             SERIAL PRIMARY KEY,
  investment_id  INT    NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  sleeve_id      TEXT   NOT NULL REFERENCES sleeves(id),
  -- What the rebalancer wanted to put here, before room capping.
  intended_cents BIGINT NOT NULL,
  -- What actually went in.
  amount_cents   BIGINT NOT NULL,
  CONSTRAINT amounts_non_negative CHECK (amount_cents >= 0 AND intended_cents >= amount_cents),
  UNIQUE (investment_id, sleeve_id)
);

CREATE INDEX investment_lines_investment_idx ON investment_lines (investment_id);
CREATE INDEX investment_lines_sleeve_idx ON investment_lines (sleeve_id);
