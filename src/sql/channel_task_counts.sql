SELECT c.id,
 (SELECT count(*) FROM crawl_message_tasks t
  WHERE t.channel_id=c.id AND t.status='failed') failed_count,
 (SELECT count(*) FROM crawl_message_tasks t
  WHERE t.channel_id=c.id AND t.status<>'failed'
  AND t.task_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')) today_success_count
FROM crawl_channels c WHERE c.id=ANY($1)
