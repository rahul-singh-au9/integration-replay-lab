CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('fixture', 'imported')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  scenario TEXT NOT NULL CHECK (length(scenario) <= 65536),
  result TEXT NOT NULL CHECK (length(result) <= 524288)
);
CREATE INDEX runs_owner_created ON runs(owner_id, created_at DESC);
CREATE INDEX runs_expiry ON runs(expires_at);
-- Counter changes atomically with each row, including deletion and expiry.
CREATE TABLE capacity (id INTEGER PRIMARY KEY CHECK (id = 1), run_count INTEGER NOT NULL);
INSERT INTO capacity (id, run_count) VALUES (1, 0);
CREATE TRIGGER runs_insert_count AFTER INSERT ON runs BEGIN
  UPDATE capacity SET run_count = run_count + 1 WHERE id = 1;
END;
CREATE TRIGGER runs_delete_count AFTER DELETE ON runs BEGIN
  UPDATE capacity SET run_count = run_count - 1 WHERE id = 1;
END;
