WITH search_log AS (
    INSERT INTO search_logs (
        session_id, user_id, keyword, ip, search_scope,
        channels_json, source_ids_json, status, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'started', now())
    RETURNING id, keyword, created_at
), hot_search AS (
    INSERT INTO hot_searches (term, normalized_term, score, last_searched, updated_at)
    SELECT keyword, $8, 1, created_at, created_at FROM search_log
    ON CONFLICT (term) DO UPDATE SET
        score = hot_searches.score + 1,
        last_searched = GREATEST(hot_searches.last_searched, excluded.last_searched),
        updated_at = GREATEST(hot_searches.updated_at, excluded.updated_at)
)
SELECT id FROM search_log;
