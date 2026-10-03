CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  credits INTEGER NOT NULL,
  redeemed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  code TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  credits_spent INTEGER NOT NULL DEFAULT 1
);
-- Server-side credit ledger. The browser never decides balances.
CREATE TABLE IF NOT EXISTS wallets (
  token TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- One free trial per IP, enforced server-side (not per-browser).
CREATE TABLE IF NOT EXISTS trials (
  ip TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
