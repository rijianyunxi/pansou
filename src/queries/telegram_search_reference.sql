WITH scoped AS (SELECT r.id,r.manual_override,r.name,r.description,r.datetime,r.cloud_types_json,r.links_json,r.tags_json,r.images_json,r.published_at,r.search_text,o.channel_id,o.message_id,o.result_json,m.published_at AS occurrence_date
FROM managed_resources r
JOIN resource_occurrences o ON o.resource_id=r.id
JOIN source_messages m USING(channel_id,message_id)
WHERE r.origin='telegram'
  AND r.enabled
  AND r.deleted_at IS NULL
  AND o.channel_id=ANY($3)
  AND m.parse_status='parsed'
  AND ($2::text IS NULL OR EXISTS(SELECT 1
FROM resource_grams g
WHERE g.resource_id=r.id
  AND g.gram=$2))),
visible AS (SELECT *,CASE WHEN manual_override THEN jsonb_build_object('id',id,'name',name,'description',description,'datetime',datetime,'cloud_types',cloud_types_json,'links',links_json,'tags',tags_json,'images',images_json) ELSE result_json END AS presentation,
lower(COALESCE(CASE WHEN manual_override THEN name ELSE result_json->>'name' END,'')) AS eff_name
FROM scoped),
matches AS (SELECT *
FROM visible
WHERE strpos(eff_name,$1)>0),
picked AS (SELECT DISTINCT ON(id) id,presentation,eff_name,occurrence_date
FROM matches
ORDER BY id,occurrence_date DESC NULLS LAST,channel_id,message_id DESC)
SELECT p.presentation || jsonb_build_object('id',p.id) AS item
FROM picked p
ORDER BY (p.eff_name=$1) DESC,(strpos(p.eff_name,$1)>0) DESC,p.occurrence_date DESC NULLS LAST,p.id LIMIT 200
