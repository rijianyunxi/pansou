-- 2026-09-30: single-owner configuration, retaining public source identities.
ALTER TABLE proxy_nodes ADD COLUMN probe_lease_until TIMESTAMPTZ;
ALTER TABLE resource_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'live' CHECK(kind IN ('live','telegram'));
UPDATE resource_sources SET kind='telegram' WHERE channel_id IS NOT NULL;
ALTER TABLE crawl_channels ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE crawl_channels ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE crawl_channels ADD COLUMN managed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE crawl_channels ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE crawl_channels ADD COLUMN transform TEXT;
ALTER TABLE crawl_channels ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
DO $$ BEGIN
 IF EXISTS(SELECT channel_id FROM resource_sources WHERE kind='telegram' GROUP BY channel_id HAVING count(DISTINCT transform)>1) THEN
  RAISE EXCEPTION 'TG 同频道存在不同 DSL，请先运行迁移预检并确认冲突';
 END IF;
END $$;
UPDATE crawl_channels c SET name=s.name,description=s.description,managed=true,transform=s.transform
FROM (SELECT DISTINCT ON(channel_id) channel_id,name,description,transform FROM resource_sources WHERE kind='telegram' ORDER BY channel_id,priority,id) s WHERE c.id=s.channel_id;
CREATE TABLE outbound_policies (
 id BIGSERIAL PRIMARY KEY,
 source_id TEXT UNIQUE REFERENCES resource_sources(id) ON DELETE CASCADE,
 channel_id TEXT UNIQUE REFERENCES crawl_channels(id) ON DELETE CASCADE,
 default_key TEXT UNIQUE CHECK(default_key='telegram'),
 mode TEXT NOT NULL CHECK(mode IN ('direct','proxy','inherit')),
 allocation TEXT NOT NULL DEFAULT 'ordered' CHECK(allocation IN ('ordered','weighted')),
 fallback TEXT NOT NULL DEFAULT 'error' CHECK(fallback IN ('error','direct')),
 unavailable_fallback TEXT NOT NULL DEFAULT 'error' CHECK(unavailable_fallback IN ('error','direct')),
 max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts BETWEEN 1 AND 5),
 replay_safe BOOLEAN NOT NULL DEFAULT false,
 version BIGINT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(source_id,channel_id,default_key)=1),
 CHECK(mode<>'inherit' OR channel_id IS NOT NULL)
);
CREATE TABLE outbound_policy_nodes (
 policy_id BIGINT NOT NULL REFERENCES outbound_policies(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL REFERENCES proxy_nodes(id) ON DELETE RESTRICT,
 weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 10000),
 position INTEGER NOT NULL CHECK(position>=0),
 PRIMARY KEY(policy_id,node_id)
);
-- A direct pseudo-node below ALL proxies means direct only when none are available.
-- Keep that condition separate from fallback after a failed request. Other mixtures are ambiguous.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM proxy_group_nodes d JOIN proxy_nodes dn ON dn.id=d.node_id JOIN proxy_group_nodes p ON p.group_id=d.group_id JOIN proxy_nodes pn ON pn.id=p.node_id WHERE dn.base_url='' AND pn.base_url<>'' AND (d.weight,d.node_id)>=(p.weight,p.node_id)) THEN
  RAISE EXCEPTION '直连伪节点优先于部分代理，须先确认精确出站规则；原配置未改动。';
 END IF;
END $$;
CREATE TEMP TABLE effective_routes AS
SELECT s.id AS source_id,s.channel_id,r.action,r.group_id,COALESCE(g.fallback_action,'error') AS fallback
FROM resource_sources s LEFT JOIN LATERAL(SELECT * FROM proxy_routes r WHERE r.enabled AND r.source_ids_json ? s.id ORDER BY r.priority,r.id LIMIT 1) r ON true LEFT JOIN proxy_groups g ON g.id=r.group_id;
INSERT INTO outbound_policies(source_id,mode,fallback,unavailable_fallback)
SELECT e.source_id,CASE WHEN e.action='group' AND EXISTS(SELECT 1 FROM proxy_group_nodes m JOIN proxy_nodes n ON n.id=m.node_id WHERE m.group_id=e.group_id AND n.base_url<>'') THEN 'proxy' ELSE 'direct' END,e.fallback,CASE WHEN EXISTS(SELECT 1 FROM proxy_group_nodes m JOIN proxy_nodes n ON n.id=m.node_id WHERE m.group_id=e.group_id AND n.base_url='' AND n.enabled) OR e.fallback='direct' THEN 'direct' ELSE 'error' END FROM effective_routes e JOIN resource_sources s ON s.id=e.source_id WHERE s.kind='live';
INSERT INTO outbound_policy_nodes(policy_id,node_id,weight,position)
SELECT p.id,m.node_id,GREATEST(1,LEAST(m.weight,10000)),(row_number() OVER(PARTITION BY p.id ORDER BY m.weight DESC,m.node_id DESC)-1)::int FROM outbound_policies p JOIN effective_routes e ON e.source_id=p.source_id JOIN proxy_group_nodes m ON m.group_id=e.group_id JOIN proxy_nodes n ON n.id=m.node_id WHERE p.mode='proxy' AND n.base_url<>'';
DO $$ BEGIN
 IF EXISTS(SELECT channel_id FROM (SELECT e.channel_id, e.action, e.fallback, COALESCE((SELECT jsonb_agg(jsonb_build_array(m.node_id,m.weight) ORDER BY m.weight DESC,m.node_id DESC) FROM proxy_group_nodes m WHERE m.group_id=e.group_id),'[]'::jsonb) AS nodes FROM effective_routes e WHERE channel_id IS NOT NULL) x GROUP BY channel_id HAVING count(DISTINCT jsonb_build_array(action,fallback,nodes))>1) THEN
  RAISE EXCEPTION '同频道的代理规则不同，请先确认频道唯一出站策略';
 END IF;
END $$;
INSERT INTO outbound_policies(channel_id,mode,fallback,unavailable_fallback)
SELECT DISTINCT ON(e.channel_id) e.channel_id,CASE WHEN e.action='group' AND EXISTS(SELECT 1 FROM proxy_group_nodes m JOIN proxy_nodes n ON n.id=m.node_id WHERE m.group_id=e.group_id AND n.base_url<>'') THEN 'proxy' ELSE 'direct' END,e.fallback,CASE WHEN EXISTS(SELECT 1 FROM proxy_group_nodes m JOIN proxy_nodes n ON n.id=m.node_id WHERE m.group_id=e.group_id AND n.base_url='' AND n.enabled) OR e.fallback='direct' THEN 'direct' ELSE 'error' END FROM effective_routes e WHERE e.channel_id IS NOT NULL ORDER BY e.channel_id,e.source_id;
INSERT INTO outbound_policy_nodes(policy_id,node_id,weight,position)
SELECT p.id,m.node_id,GREATEST(1,LEAST(m.weight,10000)),(row_number() OVER(PARTITION BY p.id ORDER BY m.weight DESC,m.node_id DESC)-1)::int FROM outbound_policies p JOIN LATERAL(SELECT e.group_id FROM effective_routes e WHERE e.channel_id=p.channel_id ORDER BY e.source_id LIMIT 1) e ON true JOIN proxy_group_nodes m ON m.group_id=e.group_id JOIN proxy_nodes n ON n.id=m.node_id WHERE p.mode='proxy' AND n.base_url<>'';
-- Preserve the old user-only inheritance as explicit independent snapshots.
INSERT INTO outbound_policies(channel_id,mode,allocation,fallback,max_attempts,unavailable_fallback)
SELECT c.id,COALESCE(p.mode,'inherit'),COALESCE(p.allocation,'ordered'),COALESCE(p.fallback,'error'),1,COALESCE(p.unavailable_fallback,'error') FROM crawl_channels c LEFT JOIN LATERAL(SELECT p.* FROM outbound_policies p JOIN resource_sources s ON s.channel_id=p.channel_id JOIN proxy_routes r ON r.enabled AND r.source_ids_json ? s.id WHERE s.enabled ORDER BY r.priority,r.id,s.priority,s.id LIMIT 1) p ON true WHERE NOT EXISTS(SELECT 1 FROM outbound_policies x WHERE x.channel_id=c.id);
INSERT INTO outbound_policy_nodes(policy_id,node_id,weight,position)
SELECT dst.id,n.node_id,n.weight,n.position FROM outbound_policies dst JOIN crawl_channels c ON c.id=dst.channel_id AND NOT c.managed JOIN LATERAL(SELECT p.id FROM outbound_policies p JOIN resource_sources s ON s.channel_id=p.channel_id JOIN proxy_routes r ON r.enabled AND r.source_ids_json ? s.id WHERE s.enabled ORDER BY r.priority,r.id,s.priority,s.id LIMIT 1) src ON true JOIN outbound_policy_nodes n ON n.policy_id=src.id WHERE dst.mode='proxy';
DROP TABLE effective_routes;
DROP TABLE proxy_routes;
DROP TABLE proxy_group_nodes;
DROP TABLE proxy_groups;
DELETE FROM proxy_nodes WHERE base_url='';
ALTER TABLE crawl_jobs ADD COLUMN target_message_id BIGINT;
ALTER TABLE crawl_jobs DROP CONSTRAINT crawl_jobs_kind_check;
ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_kind_check CHECK(kind IN ('sync','backfill','review','reparse','reparse_message'));
ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_job_target CHECK((kind='reparse_message')=(target_message_id IS NOT NULL));
DROP INDEX idx_crawl_job_active;
CREATE UNIQUE INDEX idx_crawl_job_active ON crawl_jobs(channel_id,kind,COALESCE(target_message_id,0)) WHERE status IN ('queued','running','paused');
CREATE INDEX idx_crawl_messages_status ON source_messages(channel_id,parse_status,message_id DESC);
CREATE INDEX idx_crawl_review ON source_messages(published_at DESC NULLS LAST,channel_id,message_id DESC) WHERE parse_status IN ('failed','review');
CREATE INDEX idx_crawl_jobs_filter ON crawl_jobs(channel_id,status,id DESC);
UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
