-- Link content is stored once, directly owned by a resource.
-- Existing databases prepare normalized inputs in resource_links::prepare_migration.
CREATE TABLE IF NOT EXISTS resource_link_migration_inputs (
 resource_id text NOT NULL,position integer NOT NULL,link_key text NOT NULL,old_key text NOT NULL,
 identity text NOT NULL,provider text NOT NULL,url text NOT NULL,password text,
 PRIMARY KEY(resource_id,position)
);
DO $$ BEGIN
 IF (SELECT count(*) FROM resource_link_migration_inputs) <>
    (SELECT COALESCE(sum(jsonb_array_length(links_json)),0) FROM managed_resources) THEN
  RAISE EXCEPTION 'resource link migration inputs are missing; run the application migrator';
 END IF;
END $$;

DROP TRIGGER sync_managed_links ON managed_resources;
DROP TRIGGER revise_resource_links ON managed_resources;
DROP FUNCTION enqueue_link_sync();
DROP FUNCTION revise_resource_links();
DROP TRIGGER managed_resource_revision ON managed_resources;
DROP TRIGGER managed_resource_revision_update ON managed_resources;
DROP TABLE resource_link_bindings;
DROP TABLE link_sync_queue;
ALTER TABLE link_catalog RENAME TO resource_links;
ALTER TABLE resource_links ADD COLUMN resource_id text REFERENCES managed_resources(id) ON DELETE SET NULL;
ALTER TABLE resource_links ADD COLUMN position integer;
ALTER TABLE resource_links DROP CONSTRAINT link_catalog_input_fingerprint_key;

-- Reuse the existing ID for one owner, so jobs and share artifacts retain their references.
CREATE TEMP TABLE link_first_owner ON COMMIT DROP AS
 SELECT DISTINCT ON (c.id) c.id,i.resource_id,i.position
 FROM resource_links c JOIN resource_link_migration_inputs i ON i.old_key=c.input_fingerprint
 ORDER BY c.id,i.resource_id,i.position;
UPDATE resource_links c SET resource_id=i.resource_id,position=i.position
 FROM link_first_owner i WHERE c.id=i.id;
-- Alternate owners receive independent rows with the same existing observations.
INSERT INTO resource_links(id,provider,identity,original_url,original_password,input_fingerprint,
 input_version,validity,checked_at,valid_until,last_attempt_at,next_check_at,last_error_code,
 failure_count,last_seen_at,created_at,updated_at,resource_id,position)
SELECT gen_random_uuid(),i.provider,i.identity,i.url,i.password,i.link_key,
 COALESCE(c.input_version,1),COALESCE(c.validity,-1),c.checked_at,c.valid_until,c.last_attempt_at,
 COALESCE(c.next_check_at,now()),c.last_error_code,COALESCE(c.failure_count,0),
 COALESCE(c.last_seen_at,now()),COALESCE(c.created_at,now()),COALESCE(c.updated_at,now()),i.resource_id,i.position
FROM resource_link_migration_inputs i
LEFT JOIN link_first_owner f ON f.resource_id=i.resource_id AND f.position=i.position
LEFT JOIN resource_links c ON c.input_fingerprint=i.old_key AND c.resource_id IS NOT NULL
WHERE f.id IS NULL;
-- A single old row per fingerprint makes the join above unambiguous.
UPDATE resource_links c SET original_url=i.url,original_password=i.password,provider=i.provider,input_fingerprint=i.link_key
 FROM resource_link_migration_inputs i WHERE c.resource_id=i.resource_id AND c.position=i.position;
CREATE UNIQUE INDEX resource_links_position ON resource_links(resource_id,position) WHERE resource_id IS NOT NULL;
CREATE INDEX resource_links_owner_key ON resource_links(resource_id,input_fingerprint) WHERE resource_id IS NOT NULL;
CREATE INDEX resource_links_provider_owner ON resource_links(provider,resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX resource_links_fingerprint ON resource_links(input_fingerprint);
CREATE INDEX resource_links_external_key ON resource_links(input_fingerprint) WHERE resource_id IS NULL;
-- A resource deletion must clear the associated position as well.
CREATE FUNCTION clear_detached_link_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.resource_id IS NULL THEN NEW.position=NULL; END IF; RETURN NEW; END $$;
CREATE TRIGGER resource_link_detach BEFORE UPDATE OF resource_id ON resource_links FOR EACH ROW EXECUTE FUNCTION clear_detached_link_position();

CREATE OR REPLACE FUNCTION enqueue_link_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.resource_id IS NOT NULL THEN
  INSERT INTO link_aggregate_queue(resource_id) VALUES(NEW.resource_id)
  ON CONFLICT(resource_id) DO UPDATE SET updated_at=excluded.updated_at;
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION prepare_original_check_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT c.provider INTO NEW.provider FROM resource_links c WHERE c.id=NEW.link_id;
 IF NEW.kind='original' THEN
  SELECT COALESCE(c.next_check_at,now()) INTO NEW.run_after FROM resource_links c
   WHERE c.id=NEW.link_id AND c.input_version=NEW.input_version;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION resource_links_json(resource text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('type',provider,'url',original_url,'password',original_password) ORDER BY position),'[]'::jsonb)
 FROM resource_links WHERE resource_id=resource
$$;
CREATE FUNCTION resource_link_types(resource text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(provider ORDER BY provider COLLATE "C"),'[]'::jsonb)
 FROM (SELECT DISTINCT provider FROM resource_links WHERE resource_id=resource AND provider<>'') p
$$;

CREATE FUNCTION replace_resource_links(resource text,entries jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE row_input record; matched uuid; changed boolean:=false; removed uuid[]; BEGIN
 PERFORM revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
 PERFORM id FROM managed_resources WHERE id=resource FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource does not exist: %',resource; END IF;
 IF resource_links_json(resource) = (SELECT COALESCE(jsonb_agg(jsonb_build_object('type',entry->>'provider','url',entry->>'url','password',entry->>'password') ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(entries) WITH ORDINALITY AS x(entry,ord)) THEN RETURN; END IF;
 -- Matching content keeps its ID, check results and share artifacts; position changes are cheap.
 UPDATE resource_links SET position=-position-1 WHERE resource_id=resource;
 FOR row_input IN SELECT entry,ord::integer-1 AS position FROM jsonb_array_elements(entries) WITH ORDINALITY AS x(entry,ord) ORDER BY ord LOOP
  SELECT id INTO matched FROM resource_links WHERE resource_id=resource AND position<0
   AND input_fingerprint=row_input.entry->>'linkKey' ORDER BY position DESC LIMIT 1;
  IF matched IS NULL THEN
   INSERT INTO resource_links(id,resource_id,position,provider,identity,original_url,original_password,input_fingerprint,next_check_at)
    VALUES(gen_random_uuid(),resource,row_input.position,row_input.entry->>'provider',row_input.entry->>'identity',row_input.entry->>'url',row_input.entry->>'password',row_input.entry->>'linkKey',now()) RETURNING id INTO matched;
   INSERT INTO link_check_jobs(link_id,input_version,kind,priority)
    SELECT matched,1,'original',1 WHERE row_input.entry->>'provider' IN ('baidu','quark','aliyun','xunlei','guangya')
    AND EXISTS(SELECT 1 FROM policy_settings WHERE key='link-check' AND value_json->>'enabled'='true') ON CONFLICT DO NOTHING;
  ELSE
   UPDATE resource_links SET position=row_input.position,original_url=row_input.entry->>'url' WHERE id=matched;
  END IF;
 END LOOP;
 -- Old content remains only while an outstanding cloud artifact/request needs it.
 SELECT array_agg(id) INTO removed FROM resource_links WHERE resource_id=resource AND position<0;
 DELETE FROM link_check_jobs WHERE link_id=ANY(removed) AND status='queued';
 DELETE FROM resource_links c WHERE id=ANY(removed)
  AND NOT EXISTS(SELECT 1 FROM link_share_cache s WHERE s.link_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM link_resolve_requests r WHERE r.link_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM link_check_jobs j WHERE j.link_id=c.id);
 UPDATE resource_links SET resource_id=NULL,position=NULL WHERE id=ANY(removed);
 UPDATE managed_resources SET link_validity=-1,link_validity_updated_at=NULL,updated_at=now() WHERE id=resource;
 INSERT INTO link_aggregate_queue(resource_id) VALUES(resource) ON CONFLICT(resource_id) DO UPDATE SET updated_at=excluded.updated_at;
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
END $$;

DROP INDEX idx_managed_resources_cloud_types;
ALTER TABLE managed_resources DROP COLUMN links_json;
ALTER TABLE managed_resources DROP COLUMN links_revision;
CREATE TRIGGER managed_resource_revision BEFORE INSERT OR DELETE OR UPDATE OF name,description,datetime,images_json,enabled,origin,source_channel_ids,published_at ON managed_resources FOR EACH STATEMENT EXECUTE FUNCTION lock_local_index_revision();
CREATE TRIGGER managed_resource_revision_update AFTER UPDATE ON managed_resources FOR EACH ROW WHEN
 ((old.name,old.description,old.datetime,old.images_json,old.enabled,old.origin,old.source_channel_ids,old.published_at) IS DISTINCT FROM
 (new.name,new.description,new.datetime,new.images_json,new.enabled,new.origin,new.source_channel_ids,new.published_at)) EXECUTE FUNCTION invalidate_local_index();
UPDATE policy_settings SET value_json=value_json-'linkSyncEnabled' WHERE key='background-workers';
DELETE FROM worker_lane_metrics WHERE lane='link-sync';
DELETE FROM worker_schedule_slots WHERE task='link-sync';
DROP TABLE resource_link_migration_inputs;

CREATE FUNCTION delete_resource_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM link_check_jobs WHERE link_id IN(SELECT id FROM resource_links WHERE resource_id=OLD.id) AND status='queued';
 DELETE FROM resource_links c WHERE resource_id=OLD.id
  AND NOT EXISTS(SELECT 1 FROM link_share_cache s WHERE s.link_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM link_resolve_requests r WHERE r.link_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM link_check_jobs j WHERE j.link_id=c.id);
 RETURN OLD;
END $$;
CREATE TRIGGER managed_resource_delete_links BEFORE DELETE ON managed_resources FOR EACH ROW EXECUTE FUNCTION delete_resource_links();
CREATE INDEX resource_links_detached_age ON resource_links(created_at,id) WHERE resource_id IS NULL;
ALTER TABLE resource_links ADD CONSTRAINT resource_links_owner_position CHECK ((resource_id IS NULL)=(position IS NULL));
