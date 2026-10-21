CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coins (
  id UUID PRIMARY KEY,
  mint TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT NOT NULL,
  twitter TEXT,
  image_path TEXT NOT NULL,
  metadata_uri TEXT,
  coin_wallet TEXT UNIQUE NOT NULL,
  coin_secret BYTEA NOT NULL,
  mint_secret BYTEA,
  card_count INT NOT NULL CHECK (card_count IN (10, 25, 50)),
  card_price_lamports BIGINT NOT NULL CHECK (card_price_lamports > 0),
  dev_buy_lamports BIGINT NOT NULL DEFAULT 0 CHECK (dev_buy_lamports >= 0),
  fund_lamports BIGINT NOT NULL,
  launcher_wallet TEXT NOT NULL,
  collection_address TEXT,
  collection_secret BYTEA,
  is_seed BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL,
  error TEXT,
  funding_sig TEXT UNIQUE,
  create_sig TEXT,
  buy_sig TEXT,
  token_sig TEXT,
  graduated BOOLEAN NOT NULL DEFAULT FALSE,
  tracked_lamports BIGINT NOT NULL DEFAULT 0,
  last_payout_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cards (
  id UUID PRIMARY KEY,
  coin_id UUID NOT NULL REFERENCES coins(id),
  card_number INT NOT NULL,
  asset_address TEXT UNIQUE,
  asset_secret BYTEA,
  name TEXT NOT NULL,
  image_path TEXT,
  metadata_uri TEXT,
  status TEXT NOT NULL,
  owner_wallet TEXT,
  primary_price_lamports BIGINT NOT NULL,
  accrued_lamports BIGINT NOT NULL DEFAULT 0,
  paid_lamports BIGINT NOT NULL DEFAULT 0,
  reserved_pack_id UUID,
  reserved_until TIMESTAMPTZ,
  UNIQUE (coin_id, card_number)
);

CREATE TABLE IF NOT EXISTS chain_txs (
  id TEXT PRIMARY KEY,
  signature TEXT,
  serialized TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_batches (
  id UUID PRIMARY KEY,
  coin_id UUID NOT NULL REFERENCES coins(id),
  signature TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY,
  batch_id UUID REFERENCES payout_batches(id),
  coin_id UUID NOT NULL REFERENCES coins(id),
  card_id UUID NOT NULL REFERENCES cards(id),
  holder_wallet TEXT NOT NULL,
  amount_lamports BIGINT NOT NULL CHECK (amount_lamports > 0),
  tx_sig TEXT,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  chunk INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fee_sweeps (
  id UUID PRIMARY KEY,
  coin_id UUID NOT NULL REFERENCES coins(id),
  amount_lamports BIGINT NOT NULL CHECK (amount_lamports >= 0),
  tx_sig TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS primary_sales (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES cards(id),
  buyer_wallet TEXT NOT NULL,
  price_lamports BIGINT NOT NULL,
  launcher_lamports BIGINT NOT NULL,
  platform_lamports BIGINT NOT NULL,
  payment_sig TEXT UNIQUE NOT NULL,
  transfer_sig TEXT,
  pay_sig TEXT,
  carried_sig TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES cards(id),
  seller_wallet TEXT NOT NULL,
  price_lamports BIGINT NOT NULL CHECK (price_lamports > 0),
  escrow_sig TEXT,
  payment_sig TEXT UNIQUE,
  transfer_sig TEXT,
  pay_sig TEXT,
  carried_sig TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packs (
  id UUID PRIMARY KEY,
  buyer_wallet TEXT NOT NULL,
  tier TEXT NOT NULL,
  price_lamports BIGINT NOT NULL,
  seed TEXT NOT NULL,
  payment_sig TEXT UNIQUE,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pack_cards (
  pack_id UUID NOT NULL REFERENCES packs(id),
  card_id UUID NOT NULL REFERENCES cards(id),
  position INT NOT NULL,
  transfer_sig TEXT,
  launcher_sig TEXT,
  PRIMARY KEY (pack_id, card_id)
);

CREATE TABLE IF NOT EXISTS seed_state (
  id INT PRIMARY KEY CHECK (id = 1),
  go_live_at TIMESTAMPTZ,
  cursor_wallet TEXT,
  observed_launch_lamports BIGINT
);

CREATE TABLE IF NOT EXISTS seed_launches (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  image_file TEXT NOT NULL,
  offset_seconds INT NOT NULL,
  card_price_lamports BIGINT NOT NULL,
  dev_buy_lamports BIGINT,
  status TEXT NOT NULL,
  coin_id UUID,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cards_status_idx ON cards (status);
CREATE INDEX IF NOT EXISTS cards_coin_idx ON cards (coin_id);
CREATE INDEX IF NOT EXISTS cards_owner_idx ON cards (owner_wallet);
CREATE INDEX IF NOT EXISTS payouts_card_idx ON payouts (card_id);
CREATE INDEX IF NOT EXISTS payouts_coin_idx ON payouts (coin_id);
CREATE INDEX IF NOT EXISTS fee_sweeps_coin_idx ON fee_sweeps (coin_id, created_at);
CREATE INDEX IF NOT EXISTS listings_status_idx ON listings (status);
CREATE INDEX IF NOT EXISTS coins_status_idx ON coins (status);

INSERT INTO seed_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO seed_launches (slug, name, symbol, image_file, offset_seconds, card_price_lamports, status)
VALUES
  ('feescat', 'Fees Cat', 'FEESCAT', 'feescat.png', 60, 40000000, 'pending'),
  ('paydaypup', 'Payday Pup', 'PAYDAYPUP', 'paydaypup.png', 180, 40000000, 'pending'),
  ('rentfrog', 'Rent Frog', 'RENTFROG', 'rentfrog.png', 300, 40000000, 'pending'),
  ('royaltyrat', 'Royalty Rat', 'ROYALTYRAT', 'royaltyrat.png', 600, 40000000, 'pending'),
  ('tiphamster', 'Tip Hamster', 'TIPHAMSTER', 'tiphamster.png', 900, 40000000, 'pending')
ON CONFLICT (slug) DO NOTHING;
