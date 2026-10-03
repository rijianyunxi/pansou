-- Resource JSON remains the editable/source-scoped input snapshot. Link
-- observations live only in link_catalog; resource validity is a small cache.
SET LOCAL lock_timeout='5s';
SELECT revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
LOCK TABLE managed_resources IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION resource_cloud_types(links JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT COALESCE(jsonb_agg(provider ORDER BY provider COLLATE "C"),'[]'::jsonb)
 FROM (
  SELECT DISTINCT link->>'type' AS provider
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(links)='array' THEN links ELSE '[]'::jsonb END) AS entry(link)
  WHERE jsonb_typeof(link->'type')='string' AND link->>'type'<>''
 ) providers
$$;

DROP TRIGGER managed_resource_revision ON managed_resources;
DROP TRIGGER managed_resource_revision_update ON managed_resources;
DROP TRIGGER resource_cloud_types_update ON managed_resources;
DROP INDEX idx_managed_resources_cloud_types;

ALTER TABLE managed_resources
 DROP COLUMN cloud_types_json,
 DROP COLUMN check_status,
 DROP COLUMN check_message,
 DROP COLUMN checked_at;

CREATE INDEX idx_managed_resources_cloud_types
 ON managed_resources USING gin(resource_cloud_types(links_json) jsonb_ops);

CREATE TRIGGER managed_resource_revision BEFORE INSERT OR DELETE OR UPDATE OF
 name,description,datetime,links_json,tags_json,images_json,search_text,
 enabled,manual_override,deleted_at,origin ON managed_resources
FOR EACH STATEMENT EXECUTE FUNCTION lock_local_index_revision();
CREATE TRIGGER managed_resource_revision_update AFTER UPDATE ON managed_resources FOR EACH ROW
WHEN((OLD.name,OLD.description,OLD.datetime,OLD.links_json,OLD.tags_json,
 OLD.images_json,OLD.search_text,OLD.enabled,OLD.manual_override,OLD.deleted_at,OLD.origin)
 IS DISTINCT FROM
 (NEW.name,NEW.description,NEW.datetime,NEW.links_json,NEW.tags_json,
 NEW.images_json,NEW.search_text,NEW.enabled,NEW.manual_override,NEW.deleted_at,NEW.origin))
EXECUTE FUNCTION invalidate_local_index();

-- Keep exact dropdown/count metadata without an independently writable type
-- array on every resource. Changing URL/password alone does not touch counts.
CREATE OR REPLACE FUNCTION sync_resource_cloud_types() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_types TEXT[]:='{}'; new_types TEXT[]:='{}'; item TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.deleted_at IS NULL THEN
   SELECT ARRAY(SELECT jsonb_array_elements_text(resource_cloud_types(OLD.links_json))) INTO old_types;
  END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  IF NEW.deleted_at IS NULL THEN
   SELECT ARRAY(SELECT jsonb_array_elements_text(resource_cloud_types(NEW.links_json))) INTO new_types;
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
CREATE TRIGGER resource_cloud_types_update AFTER UPDATE OF links_json,deleted_at ON managed_resources
FOR EACH ROW WHEN((OLD.links_json,OLD.deleted_at) IS DISTINCT FROM (NEW.links_json,NEW.deleted_at))
EXECUTE FUNCTION sync_resource_cloud_types();

-- Older/manual data may have a declared type that never existed in its links.
-- Rebuild metadata under the writer lock, without updating resource rows.
TRUNCATE resource_cloud_type_counts;
INSERT INTO resource_cloud_type_counts
SELECT cloud_type,count(*) FROM managed_resources r
CROSS JOIN LATERAL jsonb_array_elements_text(resource_cloud_types(r.links_json)) t(cloud_type)
WHERE r.deleted_at IS NULL GROUP BY cloud_type;

-- A historical, write-only duplicate of managed_resources.links_json. No
-- production reader or child FK uses it; retain the actual input snapshots,
-- scoped bindings, catalog observations and task references.
DROP TABLE resource_links;
UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
