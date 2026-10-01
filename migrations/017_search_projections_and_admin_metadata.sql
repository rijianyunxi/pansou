-- Derived hot data only: keep original messages/JSON and public resource IDs.
-- Writers take this lock first; backfill and trigger installation are atomic.
SELECT revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
LOCK TABLE managed_resources, source_messages, resource_occurrences IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL max_parallel_workers_per_gather=0;
SET LOCAL work_mem='32MB';

CREATE TABLE resource_search_documents (
 resource_id TEXT PRIMARY KEY REFERENCES managed_resources(id) ON DELETE CASCADE,
 active BOOLEAN NOT NULL, manual_override BOOLEAN NOT NULL, name_lower TEXT NOT NULL
);
CREATE TABLE resource_search_occurrences (
 resource_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id BIGINT NOT NULL,
 name_lower TEXT NOT NULL, published_at TIMESTAMPTZ, parsed BOOLEAN NOT NULL,
 PRIMARY KEY(resource_id,channel_id,message_id),
 FOREIGN KEY(channel_id,message_id,resource_id)
  REFERENCES resource_occurrences(channel_id,message_id,resource_id)
  ON DELETE CASCADE ON UPDATE CASCADE
);
-- Covers parent FK deletion and message parse/date changes, not just searches.
CREATE INDEX idx_search_occurrence_message ON resource_search_occurrences(channel_id,message_id,resource_id);
INSERT INTO resource_search_documents
SELECT id,origin='telegram' AND enabled AND deleted_at IS NULL,manual_override,lower(name) FROM managed_resources;
INSERT INTO resource_search_occurrences
SELECT o.resource_id,o.channel_id,o.message_id,lower(COALESCE(o.result_json->>'name','')),
 m.published_at,m.parse_status='parsed'
FROM resource_occurrences o JOIN source_messages m USING(channel_id,message_id);

CREATE FUNCTION sync_resource_search_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO resource_search_documents VALUES
 (NEW.id,NEW.origin='telegram' AND NEW.enabled AND NEW.deleted_at IS NULL,NEW.manual_override,lower(NEW.name))
 ON CONFLICT(resource_id) DO UPDATE SET active=EXCLUDED.active,
 manual_override=EXCLUDED.manual_override,name_lower=EXCLUDED.name_lower
 WHERE (resource_search_documents.active,resource_search_documents.manual_override,resource_search_documents.name_lower)
 IS DISTINCT FROM (EXCLUDED.active,EXCLUDED.manual_override,EXCLUDED.name_lower);
 RETURN NULL;
END $$;
CREATE TRIGGER search_document_insert AFTER INSERT ON managed_resources FOR EACH ROW EXECUTE FUNCTION sync_resource_search_document();
CREATE TRIGGER search_document_update AFTER UPDATE OF name,origin,enabled,deleted_at,manual_override
ON managed_resources FOR EACH ROW
WHEN((OLD.name,OLD.origin,OLD.enabled,OLD.deleted_at,OLD.manual_override)
 IS DISTINCT FROM (NEW.name,NEW.origin,NEW.enabled,NEW.deleted_at,NEW.manual_override))
EXECUTE FUNCTION sync_resource_search_document();

CREATE FUNCTION sync_resource_search_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (OLD.channel_id,OLD.message_id,OLD.resource_id,OLD.result_json)
   IS NOT DISTINCT FROM (NEW.channel_id,NEW.message_id,NEW.resource_id,NEW.result_json) THEN
   RETURN NULL;
  END IF;
 END IF;
 -- FK actions remove/move projections, including resource cascades.
 IF TG_OP<>'DELETE' THEN
  INSERT INTO resource_search_occurrences
  SELECT NEW.resource_id,NEW.channel_id,NEW.message_id,
   lower(COALESCE(NEW.result_json->>'name','')),m.published_at,m.parse_status='parsed'
  FROM source_messages m WHERE m.channel_id=NEW.channel_id AND m.message_id=NEW.message_id
  ON CONFLICT(resource_id,channel_id,message_id) DO UPDATE
  SET name_lower=EXCLUDED.name_lower,published_at=EXCLUDED.published_at,parsed=EXCLUDED.parsed
  WHERE (resource_search_occurrences.name_lower,resource_search_occurrences.published_at,resource_search_occurrences.parsed)
   IS DISTINCT FROM (EXCLUDED.name_lower,EXCLUDED.published_at,EXCLUDED.parsed);
 END IF;
 -- Presentation edits must invalidate even if the projected name did not change.
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 RETURN NULL;
END $$;
CREATE TRIGGER search_occurrence_change AFTER INSERT OR UPDATE OR DELETE ON resource_occurrences
FOR EACH ROW EXECUTE FUNCTION sync_resource_search_occurrence();

CREATE FUNCTION sync_message_search_occurrences() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed BIGINT;
BEGIN
 UPDATE resource_search_occurrences SET published_at=NEW.published_at,parsed=NEW.parse_status='parsed'
 WHERE channel_id=NEW.channel_id AND message_id=NEW.message_id
 AND (published_at,parsed) IS DISTINCT FROM (NEW.published_at,NEW.parse_status='parsed');
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
  UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 END IF;
 RETURN NULL;
END $$;
-- Date-only edits follow the same global lock order as parse-status edits.
CREATE TRIGGER message_search_lock BEFORE UPDATE OF published_at ON source_messages
FOR EACH STATEMENT EXECUTE FUNCTION lock_local_index_revision();
CREATE TRIGGER search_message_update AFTER UPDATE OF parse_status,published_at ON source_messages
FOR EACH ROW WHEN((OLD.parse_status,OLD.published_at) IS DISTINCT FROM (NEW.parse_status,NEW.published_at))
EXECUTE FUNCTION sync_message_search_occurrences();

-- Retain BEFORE locking, but invalidate only real resource changes.
DROP TRIGGER managed_resource_revision ON managed_resources;
CREATE TRIGGER managed_resource_revision BEFORE INSERT OR DELETE OR UPDATE OF
 name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,
 enabled,manual_override,deleted_at,origin ON managed_resources
FOR EACH STATEMENT EXECUTE FUNCTION lock_local_index_revision();
CREATE TRIGGER managed_resource_revision_insert_delete AFTER INSERT OR DELETE ON managed_resources
FOR EACH ROW EXECUTE FUNCTION invalidate_local_index();
CREATE TRIGGER managed_resource_revision_update AFTER UPDATE ON managed_resources FOR EACH ROW
WHEN((OLD.name,OLD.description,OLD.datetime,OLD.cloud_types_json,OLD.links_json,OLD.tags_json,
 OLD.images_json,OLD.search_text,OLD.enabled,OLD.manual_override,OLD.deleted_at,OLD.origin)
 IS DISTINCT FROM
 (NEW.name,NEW.description,NEW.datetime,NEW.cloud_types_json,NEW.links_json,NEW.tags_json,
 NEW.images_json,NEW.search_text,NEW.enabled,NEW.manual_override,NEW.deleted_at,NEW.origin))
EXECUTE FUNCTION invalidate_local_index();

-- Types present in admin-visible data, not a hard-coded provider list.
CREATE TABLE resource_cloud_type_counts (
 cloud_type TEXT PRIMARY KEY, resource_count BIGINT NOT NULL CHECK(resource_count>=0)
);
INSERT INTO resource_cloud_type_counts
SELECT cloud_type,count(*) FROM (
 SELECT DISTINCT r.id,t.cloud_type FROM managed_resources r
 CROSS JOIN LATERAL jsonb_array_elements_text(r.cloud_types_json) t(cloud_type)
 WHERE r.deleted_at IS NULL
) types GROUP BY cloud_type;
CREATE FUNCTION sync_resource_cloud_types() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_types TEXT[]:='{}'; new_types TEXT[]:='{}'; item TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.deleted_at IS NULL THEN
   SELECT ARRAY(SELECT DISTINCT jsonb_array_elements_text(OLD.cloud_types_json)) INTO old_types;
  END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  IF NEW.deleted_at IS NULL THEN
   SELECT ARRAY(SELECT DISTINCT jsonb_array_elements_text(NEW.cloud_types_json)) INTO new_types;
  END IF;
 END IF;
 FOR item IN SELECT unnest(new_types) EXCEPT SELECT unnest(old_types) LOOP
  INSERT INTO resource_cloud_type_counts VALUES(item,1)
  ON CONFLICT(cloud_type) DO UPDATE SET resource_count=resource_cloud_type_counts.resource_count+1;
 END LOOP;
 FOR item IN SELECT unnest(old_types) EXCEPT SELECT unnest(new_types) LOOP
  UPDATE resource_cloud_type_counts SET resource_count=resource_count-1 WHERE cloud_type=item;
  DELETE FROM resource_cloud_type_counts WHERE cloud_type=item AND resource_count=0;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER resource_cloud_types_insert_delete AFTER INSERT OR DELETE ON managed_resources
FOR EACH ROW EXECUTE FUNCTION sync_resource_cloud_types();
CREATE TRIGGER resource_cloud_types_update AFTER UPDATE OF cloud_types_json,deleted_at ON managed_resources
FOR EACH ROW WHEN((OLD.cloud_types_json,OLD.deleted_at) IS DISTINCT FROM (NEW.cloud_types_json,NEW.deleted_at))
EXECUTE FUNCTION sync_resource_cloud_types();
CREATE FUNCTION clear_resource_cloud_types() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 TRUNCATE resource_cloud_type_counts;
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 RETURN NULL;
END $$;
CREATE TRIGGER resource_cloud_types_truncate AFTER TRUNCATE ON managed_resources
FOR EACH STATEMENT EXECUTE FUNCTION clear_resource_cloud_types();

CREATE INDEX idx_admin_resource_page ON managed_resources(updated_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_link_catalog_recent_failure ON link_catalog(last_attempt_at DESC,id)
 WHERE failure_count>0 AND last_error_code IS NOT NULL;
CREATE INDEX idx_link_check_completed_retention ON link_check_jobs(updated_at,id) WHERE status='completed';
UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
ANALYZE resource_search_documents;
ANALYZE resource_search_occurrences;
ANALYZE resource_cloud_type_counts;
