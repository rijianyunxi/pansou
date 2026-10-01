-- All local-index writers acquire its revision row BEFORE resource/occurrence/outbox rows.
-- Parallel HTTP pages remain concurrent; their small database commits have a fixed order.
DROP TRIGGER managed_resource_revision ON managed_resources;
CREATE TRIGGER managed_resource_revision BEFORE INSERT OR DELETE OR UPDATE OF name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,enabled,manual_override,deleted_at ON managed_resources FOR EACH STATEMENT EXECUTE FUNCTION invalidate_local_index();
CREATE FUNCTION lock_local_index_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
 RETURN NULL;
END $$;
CREATE TRIGGER occurrence_commit_lock BEFORE INSERT OR UPDATE OR DELETE ON resource_occurrences FOR EACH STATEMENT EXECUTE FUNCTION lock_local_index_revision();
