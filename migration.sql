CREATE TABLE IF NOT EXISTS balance_cache (
  address TEXT PRIMARY KEY,
  balance REAL,
  bonded REAL,
  total_active_bond_base REAL,
  accrued_award REAL,
  matched_node_addresses TEXT,
  node_breakdown TEXT,
  updated_at INTEGER
);
