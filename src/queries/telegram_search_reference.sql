-- Independent unindexed oracle for resource title/search-scope tests.
SELECT jsonb_build_object('id',r.id,'name',r.name,'description',r.description,
 'datetime',r.datetime,'cloud_types',resource_link_types(r.id),
 'links',resource_links_json(r.id),'images',r.images_json) AS item
FROM managed_resources r
WHERE origin='telegram' AND enabled
AND source_channel_ids && $2::text[] AND strpos(lower(name),$1)>0
ORDER BY (lower(name)=$1) DESC,published_at DESC NULLS LAST,id LIMIT 200
