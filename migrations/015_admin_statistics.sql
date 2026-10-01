-- Resource occurrences have a foreign key. Exclude the usually tiny inactive
-- set instead of joining every wide resource row during channel statistics.
CREATE INDEX idx_inactive_resource_id ON managed_resources(id)
 WHERE NOT enabled OR deleted_at IS NOT NULL;
