-- Full history belongs to search_logs; hot_searches is a bounded shortlist.
CREATE INDEX idx_search_logs_keyword ON search_logs (keyword);

CREATE FUNCTION lock_hot_searches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(773013);
    RETURN NULL;
END;
$$;

CREATE TRIGGER hot_searches_lock BEFORE INSERT OR UPDATE OR DELETE ON hot_searches
FOR EACH STATEMENT EXECUTE FUNCTION lock_hot_searches();

CREATE FUNCTION trim_hot_searches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM hot_searches WHERE term IN (
        SELECT term FROM hot_searches
        ORDER BY pinned DESC, (source='manual' OR status<>'approved') DESC,
                 score DESC, last_searched DESC, term ASC
        OFFSET 30
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER hot_searches_retention AFTER INSERT ON hot_searches
FOR EACH STATEMENT EXECUTE FUNCTION trim_hot_searches();

-- One-time trimming also applies to databases that already accumulated keywords.
DELETE FROM hot_searches WHERE term IN (
    SELECT term FROM hot_searches
    ORDER BY pinned DESC, (source='manual' OR status<>'approved') DESC,
             score DESC, last_searched DESC, term ASC
    OFFSET 30
);
