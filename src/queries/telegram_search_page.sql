-- Rank 51 narrow rows to detect a next page; fetch descriptions/links for only 50.
WITH ranked AS MATERIALIZED (
 SELECT id,published_at,(lower(name)=$1) AS exact
 FROM managed_resources
 WHERE origin='telegram' AND enabled
 AND source_channel_ids && $3::text[]
 AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM resource_links l WHERE l.resource_id=managed_resources.id AND l.provider=$5))
 AND name_grams @> $2::text[] AND strpos(lower(name),$1)>0
 AND ($4::jsonb = 'null'::jsonb OR
      (lower(name)=$1)::int < ($4->>'exact')::boolean::int OR
      ((lower(name)=$1) = ($4->>'exact')::boolean AND (
        (published_at < ($4->>'published')::timestamptz) OR
        (published_at IS NULL AND $4->>'published' IS NOT NULL) OR
        (published_at IS NOT DISTINCT FROM ($4->>'published')::timestamptz AND id > $4->>'id')
      )))
 ORDER BY exact DESC,published_at DESC NULLS LAST,id LIMIT 51
), visible AS (
 SELECT * FROM ranked ORDER BY exact DESC,published_at DESC NULLS LAST,id LIMIT 50
)
SELECT jsonb_build_object('id',r.id,'name',r.name,'description',r.description,
 'datetime',r.datetime,'cloud_types',resource_link_types(r.id),
 'links',resource_links_json(r.id),'images',r.images_json,
 '_hasMore',(SELECT count(*)>50 FROM ranked),
 '_anchor',jsonb_build_object('id',p.id,'exact',p.exact,'published',p.published_at))
FROM visible p JOIN managed_resources r ON r.id=p.id
ORDER BY p.exact DESC,p.published_at DESC NULLS LAST,p.id
