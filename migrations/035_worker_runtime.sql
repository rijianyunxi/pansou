CREATE TABLE worker_schedule_slots (
 task TEXT PRIMARY KEY,
 next_run_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE worker_lane_metrics (
 lane TEXT PRIMARY KEY,
 processed BIGINT NOT NULL DEFAULT 0,
 runs BIGINT NOT NULL DEFAULT 0,
 failures BIGINT NOT NULL DEFAULT 0,
 last_duration_ms BIGINT NOT NULL DEFAULT 0,
 last_success_at TIMESTAMPTZ,
 last_error_at TIMESTAMPTZ,
 last_error_code TEXT
);
-- Only configuration relevant to crawl should wake its scheduler.
DROP TRIGGER crawl_switch_wakeup ON policy_settings;
CREATE FUNCTION notify_crawl_policy_wakeup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF COALESCE(NEW.key,OLD.key) IN ('background-workers','search') THEN
  PERFORM pg_notify('pansou_crawl_wakeup','');
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER crawl_switch_wakeup AFTER INSERT OR UPDATE OR DELETE ON policy_settings
 FOR EACH ROW EXECUTE FUNCTION notify_crawl_policy_wakeup();

CREATE INDEX link_resolve_active_deadline ON link_resolve_requests(deadline_at,subject_key)
 WHERE status IN('queued','running');

-- Derived resource validity is refreshed through a durable outbox. This removes
-- the shared crawl revision lock from check/sync/expiry transactions.
CREATE TABLE link_aggregate_queue (
 resource_id TEXT PRIMARY KEY REFERENCES managed_resources(id) ON DELETE CASCADE,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION enqueue_link_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO link_aggregate_queue(resource_id)
 SELECT DISTINCT resource_id FROM resource_link_bindings
 WHERE link_id=NEW.id AND scope_key='managed' ORDER BY resource_id
 ON CONFLICT(resource_id) DO UPDATE SET updated_at=excluded.updated_at;
 RETURN NULL;
END;
$$;
CREATE TRIGGER link_catalog_aggregate AFTER UPDATE OF validity,valid_until,checked_at ON link_catalog
 FOR EACH ROW WHEN ((OLD.validity,OLD.valid_until,OLD.checked_at) IS DISTINCT FROM (NEW.validity,NEW.valid_until,NEW.checked_at))
 EXECUTE FUNCTION enqueue_link_aggregate();

CREATE FUNCTION notify_worker_settings_wakeup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF COALESCE(NEW.key,OLD.key) IN ('background-workers','link-check') THEN
  PERFORM pg_notify('pansou_worker_settings_wakeup','');
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER worker_settings_wakeup AFTER INSERT OR UPDATE OR DELETE ON policy_settings
 FOR EACH ROW EXECUTE FUNCTION notify_worker_settings_wakeup();

-- Occurrence mutations must lock their resource before touching the sync outbox.
-- Sync now takes resource -> queue locks without the global index lock, so the
-- old occurrence -> queue -> resource ordering would permit a deadlock.
CREATE OR REPLACE FUNCTION enqueue_link_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource TEXT;
BEGIN
 IF TG_TABLE_NAME='managed_resources' THEN
  resource := NEW.id;
 ELSE
  resource := COALESCE(NEW.resource_id,OLD.resource_id);
  PERFORM id FROM managed_resources WHERE id=resource FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 INSERT INTO link_sync_queue(resource_id) VALUES(resource)
 ON CONFLICT(resource_id) DO UPDATE SET updated_at=now();
 RETURN NULL;
END;
$$;
