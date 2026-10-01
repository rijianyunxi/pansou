-- Claim the oldest outbox item without sorting the entire pending queue.
CREATE INDEX link_sync_queue_order ON link_sync_queue(updated_at, resource_id);

-- Maintenance only visits definitive observations whose TTL has expired.
-- Unknown observations need no periodic aggregation.
CREATE INDEX link_catalog_expiry ON link_catalog(valid_until, id)
 WHERE validity IN (0, 1) AND valid_until IS NOT NULL;
