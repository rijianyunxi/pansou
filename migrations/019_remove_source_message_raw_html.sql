-- 原文仅在采集解析时临时使用，不再长期保存。保留消息元数据及资源关联。
-- 已有原文不可恢复；历史迁移不修改，避免已部署数据库的校验和冲突。
SET LOCAL lock_timeout = '5s';
ALTER TABLE source_messages DROP COLUMN raw_html;
-- DROP COLUMN 不立即回收旧元组/TOAST 空间。停服务后在事务外单独执行：
-- VACUUM (FULL, ANALYZE) source_messages;
