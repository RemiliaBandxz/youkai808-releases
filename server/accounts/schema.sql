CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0     -- email confirmed; only then do guest purchases under that email show up
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  txn_id TEXT NOT NULL,
  product TEXT NOT NULL,
  email TEXT NOT NULL,
  user_id TEXT,
  created INTEGER NOT NULL,
  license_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | disabled (refund / chargeback)
  reset_at INTEGER NOT NULL DEFAULT 0,    -- last time the buyer freed their computers
  PRIMARY KEY (txn_id, product)
);
CREATE INDEX IF NOT EXISTS purchases_email ON purchases(email);
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS instances_key ON instances(license_key);
CREATE TABLE IF NOT EXISTS attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (       -- one-time email links
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- reset | verify
  expires INTEGER NOT NULL
);
