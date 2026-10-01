-- Backfill once, then maintain exact counts in the ingestion transaction.
-- Take the existing writer lock first to preserve the page-commit lock order.
SELECT revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
LOCK TABLE crawl_channels, source_messages, resource_occurrences IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE channel_statistics (
 channel_id TEXT PRIMARY KEY REFERENCES crawl_channels(id) ON DELETE CASCADE,
 message_count BIGINT NOT NULL DEFAULT 0 CHECK(message_count>=0),
 parsed_resource_count BIGINT NOT NULL DEFAULT 0 CHECK(parsed_resource_count>=0)
);

-- One row per distinct resource referenced by parsed messages in a channel.
-- No resource FK: occurrence DELETE triggers must decrement the channel count
-- when a resource is physically deleted and its occurrences cascade away.
CREATE TABLE channel_resource_references (
 channel_id TEXT NOT NULL REFERENCES crawl_channels(id) ON DELETE CASCADE,
 resource_id TEXT NOT NULL,
 parsed_occurrences BIGINT NOT NULL CHECK(parsed_occurrences>=0),
 PRIMARY KEY(channel_id,resource_id)
);
CREATE INDEX idx_channel_reference_resource ON channel_resource_references(resource_id,channel_id);

INSERT INTO channel_statistics(channel_id,message_count)
SELECT c.id,COALESCE(m.n,0) FROM crawl_channels c LEFT JOIN
 (SELECT channel_id,count(*) n FROM source_messages GROUP BY channel_id) m ON m.channel_id=c.id;
INSERT INTO channel_resource_references(channel_id,resource_id,parsed_occurrences)
SELECT o.channel_id,o.resource_id,count(*)
FROM resource_occurrences o JOIN source_messages m USING(channel_id,message_id)
WHERE m.parse_status='parsed' GROUP BY o.channel_id,o.resource_id;
UPDATE channel_statistics s SET parsed_resource_count=r.n
FROM (SELECT channel_id,count(*) n FROM channel_resource_references GROUP BY channel_id) r
WHERE r.channel_id=s.channel_id;

CREATE FUNCTION adjust_channel_resource_reference(ch TEXT, resource TEXT, delta BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE remaining BIGINT;
BEGIN
 IF delta>0 THEN
  INSERT INTO channel_resource_references(channel_id,resource_id,parsed_occurrences)
  VALUES(ch,resource,delta)
  ON CONFLICT(channel_id,resource_id) DO UPDATE
  SET parsed_occurrences=channel_resource_references.parsed_occurrences+EXCLUDED.parsed_occurrences
  RETURNING parsed_occurrences INTO remaining;
  IF remaining=delta THEN
   UPDATE channel_statistics SET parsed_resource_count=parsed_resource_count+1 WHERE channel_id=ch;
  END IF;
 ELSE
  UPDATE channel_resource_references SET parsed_occurrences=parsed_occurrences+delta
  WHERE channel_id=ch AND resource_id=resource RETURNING parsed_occurrences INTO remaining;
  IF remaining=0 THEN
   DELETE FROM channel_resource_references WHERE channel_id=ch AND resource_id=resource;
   UPDATE channel_statistics SET parsed_resource_count=parsed_resource_count-1 WHERE channel_id=ch;
  END IF;
 END IF;
END $$;

CREATE FUNCTION initialize_channel_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO channel_statistics(channel_id) VALUES(NEW.id);
 RETURN NULL;
END $$;
CREATE TRIGGER channel_statistics_insert AFTER INSERT ON crawl_channels
FOR EACH ROW EXECUTE FUNCTION initialize_channel_statistics();

-- Message-only writes follow the existing serialization protocol too, so a
-- parse-status edit cannot race with a resource-occurrence insert/delete.
CREATE TRIGGER message_statistics_lock
BEFORE INSERT OR DELETE OR UPDATE OF parse_status ON source_messages
FOR EACH STATEMENT EXECUTE FUNCTION lock_local_index_revision();

CREATE FUNCTION update_message_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD; delta BIGINT;
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE channel_statistics SET message_count=message_count+1 WHERE channel_id=NEW.channel_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE channel_statistics SET message_count=message_count-1 WHERE channel_id=OLD.channel_id;
  -- Run BEFORE parent deletion. Cascaded occurrence deletes see no parent and
  -- skip their decrement, so a parsed reference is removed exactly once.
  IF OLD.parse_status='parsed' THEN
   FOR item IN SELECT resource_id FROM resource_occurrences
    WHERE channel_id=OLD.channel_id AND message_id=OLD.message_id ORDER BY resource_id
   LOOP
    PERFORM adjust_channel_resource_reference(OLD.channel_id,item.resource_id,-1);
   END LOOP;
  END IF;
 ELSIF (OLD.parse_status='parsed') IS DISTINCT FROM (NEW.parse_status='parsed') THEN
  delta := CASE WHEN NEW.parse_status='parsed' THEN 1 ELSE -1 END;
  FOR item IN SELECT resource_id FROM resource_occurrences
   WHERE channel_id=NEW.channel_id AND message_id=NEW.message_id ORDER BY resource_id
  LOOP
   PERFORM adjust_channel_resource_reference(NEW.channel_id,item.resource_id,delta);
  END LOOP;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER message_statistics_insert AFTER INSERT ON source_messages
FOR EACH ROW EXECUTE FUNCTION update_message_statistics();
CREATE TRIGGER message_statistics_delete BEFORE DELETE ON source_messages
FOR EACH ROW EXECUTE FUNCTION update_message_statistics();
CREATE TRIGGER message_statistics_status AFTER UPDATE OF parse_status ON source_messages
FOR EACH ROW WHEN(OLD.parse_status IS DISTINCT FROM NEW.parse_status)
EXECUTE FUNCTION update_message_statistics();

CREATE FUNCTION update_occurrence_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (OLD.channel_id,OLD.message_id,OLD.resource_id) IS NOT DISTINCT FROM
     (NEW.channel_id,NEW.message_id,NEW.resource_id) THEN
   RETURN NULL;
  END IF;
 END IF;
 IF TG_OP IN ('DELETE','UPDATE') THEN
  IF EXISTS(SELECT 1 FROM source_messages WHERE channel_id=OLD.channel_id
            AND message_id=OLD.message_id AND parse_status='parsed') THEN
   PERFORM adjust_channel_resource_reference(OLD.channel_id,OLD.resource_id,-1);
  END IF;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  IF EXISTS(SELECT 1 FROM source_messages WHERE channel_id=NEW.channel_id
            AND message_id=NEW.message_id AND parse_status='parsed') THEN
   PERFORM adjust_channel_resource_reference(NEW.channel_id,NEW.resource_id,1);
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER occurrence_statistics
AFTER INSERT OR DELETE OR UPDATE OF channel_id,message_id,resource_id ON resource_occurrences
FOR EACH ROW EXECUTE FUNCTION update_occurrence_statistics();

ANALYZE channel_statistics;
ANALYZE channel_resource_references;
