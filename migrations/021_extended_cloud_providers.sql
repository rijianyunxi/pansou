ALTER TABLE cloud_drive_operations DROP CONSTRAINT cloud_drive_operations_provider_check;
ALTER TABLE cloud_drive_operations ADD CONSTRAINT cloud_drive_operations_provider_check
 CHECK(provider IN ('baidu','quark','aliyun','xunlei','guangya'));
ALTER TABLE link_check_enqueue_cursors DROP CONSTRAINT link_check_enqueue_cursors_provider_check;
ALTER TABLE link_check_enqueue_cursors ADD CONSTRAINT link_check_enqueue_cursors_provider_check
 CHECK(provider IN ('baidu','quark','aliyun','xunlei','guangya'));
INSERT INTO link_check_enqueue_cursors(provider) VALUES('aliyun'),('xunlei'),('guangya') ON CONFLICT DO NOTHING;
UPDATE policy_settings SET value_json = '{"aliyun":{"enabled":false},"xunlei":{"enabled":false},"guangya":{"enabled":false}}'::jsonb || value_json
 WHERE key='link-delivery';
CREATE INDEX link_cleanup_management_order ON link_cleanup_jobs(updated_at DESC,id DESC);
