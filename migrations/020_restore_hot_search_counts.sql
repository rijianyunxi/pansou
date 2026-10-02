-- Recover searches missed while the search handlers only wrote search_logs.
-- Count only logs newer than an existing term's last recorded search so that
-- previously counted searches and administrator-assigned scores are preserved.
WITH missed_searches AS (
    SELECT btrim(log.keyword) AS term,
           count(*) AS score,
           max(log.created_at) AS last_searched
    FROM search_logs log
    LEFT JOIN hot_searches hot ON hot.term = btrim(log.keyword)
    WHERE char_length(btrim(log.keyword)) BETWEEN 1 AND 100
      AND (hot.term IS NULL OR log.created_at > hot.last_searched)
    GROUP BY btrim(log.keyword)
)
INSERT INTO hot_searches (term, normalized_term, score, last_searched, updated_at)
SELECT term, lower(term), score, last_searched, now() FROM missed_searches
ON CONFLICT (term) DO UPDATE SET
    score = hot_searches.score + excluded.score,
    last_searched = GREATEST(hot_searches.last_searched, excluded.last_searched),
    updated_at = now();
