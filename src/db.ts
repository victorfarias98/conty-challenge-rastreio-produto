import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  tracking_code TEXT PRIMARY KEY,
  registered_at TEXT NOT NULL,
  last_synced_at TEXT
);

-- A chave (envio, id do evento) é o que impede a mesma consulta de duplicar o histórico.
CREATE TABLE IF NOT EXISTS tracking_events (
  tracking_code TEXT NOT NULL REFERENCES shipments (tracking_code),
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (tracking_code, event_id)
);

-- Um aviso de atraso por envio.
CREATE TABLE IF NOT EXISTS delay_alerts (
  tracking_code TEXT PRIMARY KEY REFERENCES shipments (tracking_code),
  alerted_at TEXT NOT NULL,
  transit_hours REAL NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
