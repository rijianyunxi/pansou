-- Fetch wide presentation JSON only after ranking the compact candidates.
WITH matches AS (
 SELECT d.resource_id,d.manual_override,o.channel_id,o.message_id,o.published_at,
 CASE WHEN d.manual_override THEN d.name_lower ELSE o.name_lower END AS eff_name
 FROM resource_grams g
 JOIN resource_search_documents d ON d.resource_id=g.resource_id
 JOIN resource_search_occurrences o ON o.resource_id=d.resource_id
 WHERE g.gram=$2 AND d.active AND o.parsed AND o.channel_id=ANY($3)
 AND NOT EXISTS (
  SELECT 1 FROM unnest($4::text[]) required(gram)
  WHERE NOT EXISTS (SELECT 1 FROM resource_grams extra
   WHERE extra.resource_id=d.resource_id AND extra.gram=required.gram)
 )
 AND strpos(CASE WHEN d.manual_override THEN d.name_lower ELSE o.name_lower END,$1)>0
), picked AS (
 SELECT DISTINCT ON(resource_id) * FROM matches
 ORDER BY resource_id,published_at DESC NULLS LAST,channel_id,message_id DESC
), ranked AS MATERIALIZED (
 SELECT * FROM picked
 ORDER BY (eff_name=$1) DESC,published_at DESC NULLS LAST,resource_id LIMIT 200
)
SELECT CASE WHEN p.manual_override THEN
 jsonb_build_object('id',r.id,'name',r.name,'description',r.description,'datetime',r.datetime,
 'cloud_types',resource_cloud_types(r.links_json),'links',r.links_json,'tags',r.tags_json,'images',r.images_json)
 ELSE o.result_json || jsonb_build_object('id',p.resource_id) END AS item
FROM ranked p
JOIN managed_resources r ON r.id=p.resource_id
JOIN resource_occurrences o ON o.resource_id=p.resource_id AND o.channel_id=p.channel_id AND o.message_id=p.message_id
ORDER BY (p.eff_name=$1) DESC,p.published_at DESC NULLS LAST,p.resource_id
