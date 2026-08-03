-- Migration für das Ø-Kaufpreis-Feature (geräteübergreifender Sync)
-- In der Cloudflare-Dashboard D1-Konsole deiner bestehenden Datenbank ausführen.

-- Speichert die komplette Kaufliste (JSON) pro Wallet-Adresse.
CREATE TABLE IF NOT EXISTS user_purchases (
  address TEXT PRIMARY KEY,
  data TEXT,
  updated_at INTEGER
);

-- Tombstone-Liste: merkt sich dauerhaft, welche Einträge bewusst gelöscht wurden, damit sie
-- bei einem Merge von einem anderen Gerät nicht wieder auftauchen.
CREATE TABLE IF NOT EXISTS user_purchases_deleted (
  address TEXT NOT NULL,
  deleted_id TEXT NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (address, deleted_id)
);
