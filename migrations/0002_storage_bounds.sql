-- SQLite length(TEXT) counts characters; storage limits are UTF-8 byte budgets.
-- Triggers apply the byte bounds to both existing databases and new installations.
CREATE TRIGGER runs_insert_byte_bounds BEFORE INSERT ON runs
WHEN length(CAST(NEW.scenario AS BLOB)) > 65536
  OR length(CAST(NEW.result AS BLOB)) > 524288
BEGIN
  SELECT RAISE(ABORT, 'Run storage byte limit exceeded');
END;
CREATE TRIGGER runs_update_byte_bounds BEFORE UPDATE OF scenario, result ON runs
WHEN length(CAST(NEW.scenario AS BLOB)) > 65536
  OR length(CAST(NEW.result AS BLOB)) > 524288
BEGIN
  SELECT RAISE(ABORT, 'Run storage byte limit exceeded');
END;

-- Retention keeps expired rows until the scheduled cleanup. Filtering the owner
-- and expiry together bounds active-workspace capacity checks without table scans.
CREATE INDEX runs_owner_expiry ON runs(owner_id, expires_at);
