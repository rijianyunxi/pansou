-- Keep the exact message that failed parsing, without retaining every successful post.
ALTER TABLE crawl_message_tasks
    ADD COLUMN raw_html text,
    ADD COLUMN published_at timestamptz;

COMMENT ON COLUMN crawl_message_tasks.raw_html IS 'Original Telegram message HTML captured on parsing failure; legacy failures may be NULL';
