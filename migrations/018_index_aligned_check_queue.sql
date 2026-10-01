-- Queue order is now priority, due time, ID (FIFO), not catalog.last_seen_at.
-- Keep provider/due time in the queue so claiming never sorts a catalog join.
ALTER TABLE link_check_jobs ADD COLUMN provider TEXT;
UPDATE link_check_jobs j SET provider=c.provider,run_after=COALESCE(c.next_check_at,'infinity'::timestamptz)
FROM link_catalog c WHERE c.id=j.link_id AND j.kind='original' AND j.status='queued';
UPDATE link_check_jobs j SET provider=c.provider FROM link_catalog c WHERE c.id=j.link_id AND j.provider IS NULL;
ALTER TABLE link_check_jobs ALTER COLUMN provider SET NOT NULL;
UPDATE link_check_jobs SET priority=CASE WHEN priority>=10 THEN 10 WHEN priority>0 THEN 1 ELSE 0 END WHERE kind='original';
ALTER TABLE link_check_jobs ADD CONSTRAINT link_check_original_priority CHECK(kind<>'original' OR priority IN(0,1,10));

CREATE FUNCTION prepare_original_check_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT c.provider INTO NEW.provider FROM link_catalog c WHERE c.id=NEW.link_id;
 IF NEW.kind='original' AND NEW.status='queued' THEN
  SELECT COALESCE(c.next_check_at,'infinity'::timestamptz) INTO NEW.run_after
  FROM link_catalog c WHERE c.id=NEW.link_id AND c.input_version=NEW.input_version;
  NEW.run_after:=COALESCE(NEW.run_after,'infinity'::timestamptz);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER link_check_prepare BEFORE INSERT OR UPDATE OF link_id,input_version,status
ON link_check_jobs FOR EACH ROW EXECUTE FUNCTION prepare_original_check_job();

-- Catalog writers may lock queued jobs, but queue writers only READ the catalog:
-- no reverse row-lock acquisition and no running-job mutation from this trigger.
CREATE FUNCTION reschedule_original_check_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE link_check_jobs SET provider=NEW.provider,
  run_after=COALESCE(NEW.next_check_at,'infinity'::timestamptz)
 WHERE link_id=NEW.id AND input_version=NEW.input_version AND kind='original'
  AND status='queued'
  AND (provider,run_after) IS DISTINCT FROM
   (NEW.provider,COALESCE(NEW.next_check_at,'infinity'::timestamptz));
 RETURN NEW;
END $$;
CREATE TRIGGER link_catalog_reschedule_checks AFTER UPDATE OF provider,next_check_at ON link_catalog
FOR EACH ROW WHEN ((OLD.provider,OLD.next_check_at) IS DISTINCT FROM (NEW.provider,NEW.next_check_at))
EXECUTE FUNCTION reschedule_original_check_jobs();

CREATE INDEX idx_check_queued_claim ON link_check_jobs(provider,priority,run_after,id)
 WHERE kind='original' AND status='queued';
CREATE INDEX idx_check_expired_lease ON link_check_jobs(lease_until,id)
 WHERE kind='original' AND status='running';
DROP INDEX link_check_due;

-- A bounded keyset walk inspects at most 256 catalog rows per provider/tick.
-- Even when every due link is already queued, it does not scan the entire catalog.
CREATE TABLE link_check_enqueue_cursors (
 provider TEXT PRIMARY KEY CHECK(provider IN('baidu','quark')),
 next_check_at TIMESTAMPTZ,
 link_id UUID,
 CHECK((next_check_at IS NULL)=(link_id IS NULL))
);
INSERT INTO link_check_enqueue_cursors(provider) VALUES('baidu'),('quark');

-- These predicates/orderings have no production query consumers after 017.
-- Keep the administrator name GIN, gram indexes and fingerprint uniqueness.
DROP INDEX idx_managed_resources_search_trgm;
DROP INDEX idx_resource_tg_name;
DROP INDEX idx_resource_tg_date;
ANALYZE link_check_jobs;
