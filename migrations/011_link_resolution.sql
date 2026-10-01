-- New link delivery storage. Historical migrations remain untouched.
ALTER TABLE managed_resources ADD COLUMN link_validity SMALLINT NOT NULL DEFAULT -1 CHECK(link_validity IN(-1,0,1)),
 ADD COLUMN link_validity_updated_at TIMESTAMPTZ,
 ADD COLUMN links_revision BIGINT NOT NULL DEFAULT 1;
CREATE TABLE link_catalog(
 id UUID PRIMARY KEY, provider TEXT NOT NULL, identity TEXT NOT NULL,
 original_url TEXT NOT NULL, original_password TEXT, input_fingerprint TEXT NOT NULL UNIQUE,
 input_version BIGINT NOT NULL DEFAULT 1, validity SMALLINT NOT NULL DEFAULT -1 CHECK(validity IN(-1,0,1)),
 checked_at TIMESTAMPTZ, valid_until TIMESTAMPTZ, last_attempt_at TIMESTAMPTZ, next_check_at TIMESTAMPTZ,
 last_error_code TEXT, failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX link_catalog_due ON link_catalog(provider,next_check_at,id);
CREATE TABLE resource_link_bindings(
 resource_id TEXT NOT NULL REFERENCES managed_resources(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL, link_key TEXT NOT NULL, link_id UUID NOT NULL REFERENCES link_catalog(id),
 links_revision BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(resource_id,scope_key,link_key));
CREATE INDEX resource_link_bindings_link ON resource_link_bindings(link_id,resource_id);
CREATE TABLE link_share_cache(
 id UUID PRIMARY KEY, link_id UUID NOT NULL REFERENCES link_catalog(id), input_version BIGINT NOT NULL,
 target_account_key TEXT NOT NULL, account_revision BIGINT NOT NULL, policy_revision BIGINT NOT NULL,
 target_dir TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('saving','saved','sharing','ready','invalid','uncertain','failed','expiring','cleaning','deleted')),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0), owned_dir_id TEXT, owned_dir_path TEXT,
 ownership_manifest_json JSONB NOT NULL DEFAULT '{}', upstream_share_ids_json JSONB NOT NULL DEFAULT '[]',
 retention_seconds INTEGER NOT NULL CHECK(retention_seconds>0), cleanup_after TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ,
 target_files_json JSONB NOT NULL DEFAULT '[]', upstream_task_id TEXT, share_url TEXT, share_password TEXT,
 share_validity SMALLINT NOT NULL DEFAULT -1 CHECK(share_validity IN(-1,0,1)),
 share_checked_at TIMESTAMPTZ, share_valid_until TIMESTAMPTZ, share_expires_at TIMESTAMPTZ,
 lease_token UUID, lease_until TIMESTAMPTZ, last_error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(state<>'ready' OR length(share_url)>0),
 UNIQUE(link_id,input_version,target_account_key,account_revision,target_dir,policy_revision,generation));
CREATE UNIQUE INDEX link_share_active ON link_share_cache(link_id,input_version,target_account_key,account_revision,target_dir,policy_revision)
 WHERE state NOT IN('expiring','cleaning','deleted');
CREATE INDEX link_share_cleanup ON link_share_cache(cleanup_after,id) WHERE state<>'deleted';
CREATE TABLE link_resolve_requests(
 id UUID PRIMARY KEY, request_key UUID NOT NULL, subject_key TEXT NOT NULL,
 user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, request_fingerprint TEXT NOT NULL,
 link_id UUID NOT NULL REFERENCES link_catalog(id), share_cache_id UUID REFERENCES link_share_cache(id),
 authorization_json JSONB NOT NULL, status TEXT NOT NULL CHECK(status IN('queued','running','completed','failed')),
 delivery TEXT, reason_code TEXT, result_kind TEXT CHECK(result_kind IN('available','unavailable')),
 response_json JSONB, deadline_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days', UNIQUE(subject_key,request_key));
CREATE INDEX link_resolve_deadline ON link_resolve_requests(status,deadline_at);
CREATE INDEX link_resolve_expiry ON link_resolve_requests(expires_at);
CREATE TABLE link_check_jobs(
 id BIGSERIAL PRIMARY KEY, link_id UUID NOT NULL REFERENCES link_catalog(id), input_version BIGINT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('original','reshared')), share_cache_id UUID REFERENCES link_share_cache(id),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','completed','failed')),
 priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 run_after TIMESTAMPTZ NOT NULL DEFAULT now(), lease_token UUID, lease_until TIMESTAMPTZ, last_error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((kind='original' AND share_cache_id IS NULL) OR (kind='reshared' AND share_cache_id IS NOT NULL)));
CREATE UNIQUE INDEX link_check_original_active ON link_check_jobs(link_id,input_version) WHERE kind='original' AND status IN('queued','running');
CREATE UNIQUE INDEX link_check_share_active ON link_check_jobs(share_cache_id,input_version) WHERE kind='reshared' AND status IN('queued','running');
CREATE INDEX link_check_due ON link_check_jobs(run_after,priority,id) WHERE status IN('queued','running');
CREATE TABLE link_cleanup_jobs(
 id BIGSERIAL PRIMARY KEY, share_cache_id UUID NOT NULL REFERENCES link_share_cache(id),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','completed','failed','blocked')),
 stage TEXT NOT NULL DEFAULT 'verify' CHECK(stage IN('verify','revoke_shares','delete_files','verify_deleted')),
 progress_json JSONB NOT NULL DEFAULT '{}', run_after TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 lease_token UUID, lease_until TIMESTAMPTZ, last_error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ);
CREATE UNIQUE INDEX link_cleanup_active ON link_cleanup_jobs(share_cache_id) WHERE status IN('queued','running','blocked');
CREATE INDEX link_cleanup_due ON link_cleanup_jobs(run_after,id) WHERE status IN('queued','running');

-- Transactional outbox: ingestion/admin edits never do upstream network IO.
CREATE TABLE link_sync_queue(resource_id TEXT PRIMARY KEY REFERENCES managed_resources(id) ON DELETE CASCADE,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE FUNCTION enqueue_link_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='managed_resources' THEN
   INSERT INTO link_sync_queue(resource_id) VALUES(NEW.id) ON CONFLICT(resource_id) DO UPDATE SET updated_at=now();
 ELSE
   INSERT INTO link_sync_queue(resource_id) SELECT COALESCE(NEW.resource_id,OLD.resource_id)
     WHERE EXISTS(SELECT 1 FROM managed_resources WHERE id=COALESCE(NEW.resource_id,OLD.resource_id))
     ON CONFLICT(resource_id) DO UPDATE SET updated_at=now();
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION revise_resource_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.links_json IS DISTINCT FROM OLD.links_json OR NEW.manual_override IS DISTINCT FROM OLD.manual_override THEN
  NEW.links_revision=OLD.links_revision+1; NEW.link_validity=-1; NEW.link_validity_updated_at=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revise_resource_links BEFORE UPDATE OF links_json,manual_override ON managed_resources FOR EACH ROW EXECUTE FUNCTION revise_resource_links();
CREATE TRIGGER sync_managed_links AFTER INSERT OR UPDATE OF links_json,manual_override ON managed_resources FOR EACH ROW EXECUTE FUNCTION enqueue_link_sync();
CREATE TRIGGER sync_occurrence_links AFTER INSERT OR UPDATE OR DELETE ON resource_occurrences FOR EACH ROW EXECUTE FUNCTION enqueue_link_sync();
-- Status refreshes must not invalidate the complete local search cache.
DROP TRIGGER managed_resource_revision ON managed_resources;
CREATE TRIGGER managed_resource_revision AFTER INSERT OR DELETE OR UPDATE OF name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,enabled,manual_override,deleted_at ON managed_resources FOR EACH STATEMENT EXECUTE FUNCTION invalidate_local_index();
INSERT INTO link_sync_queue(resource_id) SELECT id FROM managed_resources;
INSERT INTO policy_settings(key,value_json) VALUES
 ('link-delivery','{"revision":1,"baidu":{"enabled":false},"quark":{"enabled":false}}'),
 ('link-check','{"enabled":false,"validSeconds":86400,"invalidSeconds":604800,"intervalSeconds":2,"dailyBudget":1000}')
 ON CONFLICT DO NOTHING;
