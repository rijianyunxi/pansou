-- Weighted priority only; direct is a protected built-in node.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM proxy_nodes WHERE id='direct') THEN RAISE EXCEPTION 'reserved node id direct already exists'; END IF;
END $$;
ALTER TABLE proxy_nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'proxy' CHECK(kind IN ('proxy','direct'));
INSERT INTO proxy_nodes(id,name,base_url,enabled,kind) VALUES('direct','直连','',true,'direct');
ALTER TABLE proxy_nodes ADD CONSTRAINT proxy_node_kind_url CHECK((kind='direct' AND id='direct' AND base_url='' AND enabled AND daily_limit=0) OR (kind='proxy' AND id<>'direct' AND base_url<>''));
ALTER TABLE outbound_policy_nodes DROP CONSTRAINT outbound_policy_nodes_weight_check;
ALTER TABLE outbound_policy_nodes ADD CONSTRAINT outbound_policy_nodes_weight_check CHECK(weight BETWEEN 0 AND 10000);
INSERT INTO outbound_policy_nodes(policy_id,node_id,weight,position)
SELECT p.id,'direct',CASE WHEN p.mode='direct' THEN 10 ELSE 0 END,COALESCE((SELECT max(position)+1 FROM outbound_policy_nodes WHERE policy_id=p.id),0)
FROM outbound_policies p WHERE p.mode='direct' OR p.fallback='direct' OR p.unavailable_fallback='direct';
ALTER TABLE outbound_policies ADD COLUMN inherit BOOLEAN NOT NULL DEFAULT false;
UPDATE outbound_policies SET inherit=(mode='inherit'),version=version+1;
ALTER TABLE outbound_policies DROP COLUMN mode CASCADE, DROP COLUMN allocation, DROP COLUMN fallback, DROP COLUMN unavailable_fallback, DROP COLUMN max_attempts, DROP COLUMN replay_safe;
ALTER TABLE outbound_policies ADD CONSTRAINT inherit_only_channel CHECK(NOT inherit OR channel_id IS NOT NULL);
ALTER TABLE outbound_policy_nodes DROP COLUMN position;
CREATE INDEX idx_outbound_node_reference ON outbound_policy_nodes(node_id,policy_id);

-- Batch channel counts use covering indexes instead of repeatedly fetching large resource rows.
CREATE INDEX idx_active_resource_id ON managed_resources(id) WHERE enabled AND deleted_at IS NULL;
CREATE INDEX idx_occurrence_channel_resource ON resource_occurrences(channel_id,resource_id,message_id);
CREATE INDEX idx_channel_latest_job ON crawl_jobs(channel_id,id DESC);

-- Telegram ingestion maintains the union of all occurrence grams in Rust, once.
-- Manual resources / manual overrides still keep database-side index maintenance.
CREATE OR REPLACE FUNCTION index_resource_text() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content TEXT; grams TEXT[];
BEGIN
 content := lower(NEW.search_text);
 SELECT COALESCE(array_agg(DISTINCT gram),'{}'::text[]) INTO grams FROM (
 SELECT substring(content FROM p FOR n) gram FROM generate_series(1,char_length(content)) p CROSS JOIN generate_series(1,2) n
 WHERE p+n-1<=char_length(content) AND btrim(substring(content FROM p FOR n))<>''
 ) g;
 DELETE FROM resource_grams WHERE resource_id=NEW.id AND NOT (gram=ANY(grams));
 INSERT INTO resource_grams(resource_id,gram) SELECT NEW.id,unnest(grams) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER managed_resource_grams ON managed_resources;
CREATE TRIGGER managed_resource_grams_insert AFTER INSERT ON managed_resources FOR EACH ROW WHEN(NEW.origin<>'telegram' OR NEW.manual_override) EXECUTE FUNCTION index_resource_text();
CREATE TRIGGER managed_resource_grams_update AFTER UPDATE OF search_text,manual_override ON managed_resources FOR EACH ROW WHEN((NEW.origin<>'telegram' OR NEW.manual_override) AND (OLD.search_text IS DISTINCT FROM NEW.search_text OR OLD.manual_override IS DISTINCT FROM NEW.manual_override)) EXECUTE FUNCTION index_resource_text();
