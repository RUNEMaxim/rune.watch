-- Aufräum-Migration: entfernt Tabellen aus früheren APY-Experimenten (netzwerkweite APY und
-- persönliche 30d/90d/365d-APY), die beide wieder aus dem Worker-Code entfernt wurden, weil sie
-- die Bond-Historie-Anzeige im Frontend destabilisiert haben (zusätzliche Last, kurzzeitige
-- 'building'-Statuswechsel). Nur ausführen, falls du eine der beiden alten Migrationen
-- (migration_network_apy.sql, migration_personal_apy.sql) schon mal angewendet hattest.
--
-- Ausführen mit:
--   npx wrangler d1 execute <DEIN_DB_NAME> --remote --file=./migration_cleanup_apy_tables.sql

DROP TABLE IF EXISTS network_apy_cache;
DROP TABLE IF EXISTS bond_flow_rows;
