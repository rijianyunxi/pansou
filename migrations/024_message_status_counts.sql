-- Per-status message counts feed the workbench "入库/失败" column and the
-- message drawer totals without counting source_messages at read time.
SELECT revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
LOCK TABLE channel_statistics, source_messages IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE channel_statistics
 ADD COLUMN parsed_count BIGINT NOT NULL DEFAULT 0 CHECK(parsed_count>=0),
 ADD COLUMN empty_count BIGINT NOT NULL DEFAULT 0 CHECK(empty_count>=0),
 ADD COLUMN failed_count BIGINT NOT NULL DEFAULT 0 CHECK(failed_count>=0);

UPDATE channel_statistics s SET parsed_count=m.parsed,empty_count=m.empty,failed_count=m.failed
FROM (SELECT channel_id,
       count(*) FILTER(WHERE parse_status='parsed') parsed,
       count(*) FILTER(WHERE parse_status='empty') empty,
       count(*) FILTER(WHERE parse_status='failed') failed
      FROM source_messages GROUP BY channel_id) m
WHERE m.channel_id=s.channel_id;

-- Same semantics as the 016 trigger, plus the per-status counters.
CREATE OR REPLACE FUNCTION update_message_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD; delta BIGINT;
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE channel_statistics SET message_count=message_count+1,
   parsed_count=parsed_count+(NEW.parse_status='parsed')::int,
   empty_count=empty_count+(NEW.parse_status='empty')::int,
   failed_count=failed_count+(NEW.parse_status='failed')::int
  WHERE channel_id=NEW.channel_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE channel_statistics SET message_count=message_count-1,
   parsed_count=parsed_count-(OLD.parse_status='parsed')::int,
   empty_count=empty_count-(OLD.parse_status='empty')::int,
   failed_count=failed_count-(OLD.parse_status='failed')::int
  WHERE channel_id=OLD.channel_id;
  -- Run BEFORE parent deletion. Cascaded occurrence deletes see no parent and
  -- skip their decrement, so a parsed reference is removed exactly once.
  IF OLD.parse_status='parsed' THEN
   FOR item IN SELECT resource_id FROM resource_occurrences
    WHERE channel_id=OLD.channel_id AND message_id=OLD.message_id ORDER BY resource_id
   LOOP
    PERFORM adjust_channel_resource_reference(OLD.channel_id,item.resource_id,-1);
   END LOOP;
  END IF;
 ELSE
  UPDATE channel_statistics SET
   parsed_count=parsed_count+(NEW.parse_status='parsed')::int-(OLD.parse_status='parsed')::int,
   empty_count=empty_count+(NEW.parse_status='empty')::int-(OLD.parse_status='empty')::int,
   failed_count=failed_count+(NEW.parse_status='failed')::int-(OLD.parse_status='failed')::int
  WHERE channel_id=NEW.channel_id;
  IF (OLD.parse_status='parsed') IS DISTINCT FROM (NEW.parse_status='parsed') THEN
   delta := CASE WHEN NEW.parse_status='parsed' THEN 1 ELSE -1 END;
   FOR item IN SELECT resource_id FROM resource_occurrences
    WHERE channel_id=NEW.channel_id AND message_id=NEW.message_id ORDER BY resource_id
   LOOP
    PERFORM adjust_channel_resource_reference(NEW.channel_id,item.resource_id,delta);
   END LOOP;
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
