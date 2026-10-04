-- Owner lookups read at most the resource's links through resource_links_position.
-- External lookups use resource_links_external_key; tasks use the UUID primary key.
DROP INDEX IF EXISTS resource_links_owner_key;
DROP INDEX IF EXISTS resource_links_fingerprint;
