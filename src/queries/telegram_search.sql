-- Punctuation-only keywords scan the compact projection, never raw message/JSON tables.
-- Do not truncate candidates: preserve matching and authorized-channel semantics.
WITH matches AS (
 -- Split override/non-override matching so each name predicate can be applied
 -- before the join. A CASE predicate would hash-join every projection row.
 SELECT d.resource_id,d.manual_override,o.channel_id,o.message_id,o.published_at,o.name_lower AS eff_name
 FROM resource_search_occurrences o
 JOIN resource_search_documents d ON d.resource_id=o.resource_id
 WHERE d.active AND NOT d.manual_override AND o.parsed AND o.channel_id=ANY($3)
 AND strpos(o.name_lower,$1)>0
 AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM resource_grams g
  WHERE g.resource_id=d.resource_id AND g.gram=$2))
 UNION ALL
 SELECT d.resource_id,d.manual_override,o.channel_id,o.message_id,o.published_at,d.name_lower AS eff_name
 FROM resource_search_documents d
 JOIN resource_search_occurrences o ON o.resource_id=d.resource_id
 WHERE d.active AND d.manual_override AND o.parsed AND o.channel_id=ANY($3)
 AND strpos(d.name_lower,$1)>0
 AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM resource_grams g
  WHERE g.resource_id=d.resource_id AND g.gram=$2))
), picked AS (
 SELECT DISTINCT ON(resource_id) * FROM matches
 ORDER BY resource_id,published_at DESC NULLS LAST,channel_id,message_id DESC
), ranked AS MATERIALIZED (
 SELECT * FROM picked
 ORDER BY (eff_name=$1) DESC,published_at DESC NULLS LAST,resource_id LIMIT 200
)
SELECT CASE WHEN p.manual_override THEN
 jsonb_build_object('id',r.id,'name',r.name,'description',r.description,'datetime',r.datetime,
 'cloud_types',r.cloud_types_json,'links',r.links_json,'tags',r.tags_json,'images',r.images_json)
 ELSE o.result_json || jsonb_build_object('id',p.resource_id) END AS item
FROM ranked p
JOIN managed_resources r ON r.id=p.resource_id
JOIN resource_occurrences o ON o.resource_id=p.resource_id AND o.channel_id=p.channel_id AND o.message_id=p.message_id
ORDER BY (p.eff_name=$1) DESC,p.published_at DESC NULLS LAST,p.resource_id
