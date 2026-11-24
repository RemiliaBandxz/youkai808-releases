CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,    -- email confirmed; only then do guest purchases under that email show up
  role TEXT NOT NULL DEFAULT 'user',      -- 'owner' = admin panel. Only settable in the D1 console, never via the API.
  totp_secret TEXT,                       -- AES-GCM encrypted base32 secret (2FA), NULL = not set up
  totp_pending TEXT,                      -- encrypted secret during setup, before the first code confirms it
  totp_last INTEGER NOT NULL DEFAULT 0    -- last accepted 30s step, so a code can't be replayed
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  mfa INTEGER NOT NULL DEFAULT 0          -- 1 = this login passed 2FA
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
CREATE TABLE IF NOT EXISTS admin_log (
  at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hub_links (   -- "Log In With Browser" for the Hub app (device-code flow)
  device_hash TEXT PRIMARY KEY,           -- sha256 of the secret the Hub polls with
  user_code TEXT UNIQUE NOT NULL,         -- short code shown in the Hub + browser
  user_id TEXT,                           -- set when the logged-in buyer approves on the website
  expires INTEGER NOT NULL
);
-- Upgrading a database made before the owner login:
-- ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'; ALTER TABLE users ADD COLUMN totp_secret TEXT;
-- ALTER TABLE users ADD COLUMN totp_pending TEXT; ALTER TABLE users ADD COLUMN totp_last INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 0;
-- Make the owner (after she signs up):  UPDATE users SET role='owner' WHERE email='<her login email>';
