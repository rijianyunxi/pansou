-- Only resource titles participate in search. Descriptions and tags remain stored/displayed.
CREATE OR REPLACE FUNCTION index_resource_text() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content TEXT; grams TEXT[];
BEGIN
 content:=lower(NEW.name);
 SELECT COALESCE(array_agg(DISTINCT gram),'{}'::text[]) INTO grams FROM (
 SELECT substring(content FROM p FOR n) gram FROM generate_series(1,char_length(content)) p CROSS JOIN generate_series(1,2) n
 WHERE p+n-1<=char_length(content) AND substring(content FROM p FOR n)~'^[[:alnum:]]+$'
 ) g;
 DELETE FROM resource_grams WHERE resource_id=NEW.id AND NOT(gram=ANY(grams));
 INSERT INTO resource_grams(resource_id,gram) SELECT NEW.id,unnest(grams) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER managed_resource_grams_update ON managed_resources;
CREATE TRIGGER managed_resource_grams_update AFTER UPDATE OF name,manual_override ON managed_resources FOR EACH ROW WHEN((NEW.origin<>'telegram' OR NEW.manual_override) AND (OLD.name IS DISTINCT FROM NEW.name OR OLD.manual_override IS DISTINCT FROM NEW.manual_override)) EXECUTE FUNCTION index_resource_text();
-- Rebuild derived index, never delete resource/message/description data.
TRUNCATE resource_grams;
INSERT INTO resource_grams(resource_id,gram)
WITH titles AS (
 SELECT id resource_id,lower(name) title FROM managed_resources
 UNION
 SELECT o.resource_id,lower(COALESCE(o.result_json->>'name','')) FROM resource_occurrences o
 JOIN source_messages m USING(channel_id,message_id) JOIN managed_resources r ON r.id=o.resource_id
 WHERE NOT r.manual_override AND m.parse_status='parsed'
)
SELECT DISTINCT resource_id,substring(title FROM p FOR n) gram FROM titles
CROSS JOIN LATERAL generate_series(1,char_length(title)) p CROSS JOIN generate_series(1,2) n
WHERE p+n-1<=char_length(title) AND substring(title FROM p FOR n)~'^[[:alnum:]]+$';
CREATE INDEX idx_resource_name_admin ON managed_resources USING gin(name gin_trgm_ops) WHERE deleted_at IS NULL;
UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
ANALYZE resource_grams;
