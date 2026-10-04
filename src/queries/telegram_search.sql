-- Match and rank resource IDs before fetching wide descriptions and link JSON.
WITH ranked AS MATERIALIZED (
 SELECT id,published_at,(lower(name)=$1) AS exact
 FROM managed_resources
 WHERE origin='telegram' AND enabled
 AND source_channel_ids && $3::text[]
 AND name_grams @> $2::text[]
 AND strpos(lower(name),$1)>0
 ORDER BY exact DESC,published_at DESC NULLS LAST,id LIMIT 200
)
SELECT jsonb_build_object('id',r.id,'name',r.name,'description',r.description,
 'datetime',r.datetime,'cloud_types',resource_link_types(r.id),
 'links',resource_links_json(r.id),'images',r.images_json) AS item
FROM ranked p JOIN managed_resources r ON r.id=p.id
ORDER BY p.exact DESC,p.published_at DESC NULLS LAST,p.id
