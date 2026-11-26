-- Key/value runtime state. semantic_status: 'ok' | 'degraded' (set by the daily canary).
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO settings (key, value, updated_at) VALUES ('semantic_status', 'ok', datetime('now'));
