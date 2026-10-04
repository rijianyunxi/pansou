-- Freeze inherited settings before removing global TG configuration.
-- Run with the previous API/workers stopped to prevent writes during upgrade.
UPDATE crawl_channels c
SET transform=t.transform,version=c.version+1,updated_at=now()
FROM source_template_settings t WHERE t.id=1 AND c.transform IS NULL;

DELETE FROM outbound_policy_nodes n USING outbound_policies p
WHERE n.policy_id=p.id AND p.inherit;
INSERT INTO outbound_policy_nodes(policy_id,node_id,weight)
SELECT channel.id,n.node_id,n.weight
FROM outbound_policies channel
JOIN outbound_policies defaults ON defaults.default_key='telegram'
JOIN outbound_policy_nodes n ON n.policy_id=defaults.id
WHERE channel.inherit;
UPDATE outbound_policies SET inherit=false,version=version+1,updated_at=now() WHERE inherit;
DELETE FROM outbound_policies WHERE default_key IS NOT NULL;
ALTER TABLE outbound_policies DROP COLUMN inherit, DROP COLUMN default_key;
ALTER TABLE outbound_policies ADD CONSTRAINT outbound_policy_owner CHECK(num_nonnulls(source_id,channel_id)=1);
DROP TABLE source_template_settings;
UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
