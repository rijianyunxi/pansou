SELECT c.id,
 (SELECT count(*) FROM crawl_message_tasks t WHERE t.channel_id=c.id AND t.status='failed') failed_count,
 (SELECT count(*) FROM managed_resources r WHERE r.enabled
  AND r.source_channel_ids @> ARRAY[c.id]) resource_count,
 (SELECT count(DISTINCT r.id) FROM crawl_message_tasks t
  CROSS JOIN LATERAL unnest(t.resource_ids) ids(resource_id)
  JOIN managed_resources r ON r.id=ids.resource_id
  WHERE t.channel_id=c.id AND t.status='parsed'
  AND t.task_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
  AND r.enabled) today_resource_count
FROM crawl_channels c WHERE c.id=ANY($1)
