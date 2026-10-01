WITH facts AS (
 SELECT ids.resource_id,
  CASE WHEN bool_or(COALESCE(c.validity=1 AND c.valid_until>now(), false)) THEN 1
       WHEN count(c.id)>0 AND bool_and(COALESCE(c.validity=0 AND c.valid_until>now(), false)) THEN 0
       ELSE -1 END::smallint AS validity,
  MAX(c.checked_at) AS checked
 FROM unnest($1::text[]) AS ids(resource_id)
 LEFT JOIN resource_link_bindings b ON b.resource_id=ids.resource_id AND b.scope_key='managed'
 LEFT JOIN link_catalog c ON c.id=b.link_id
 GROUP BY ids.resource_id
)
UPDATE managed_resources r SET
 link_validity=f.validity, link_validity_updated_at=f.checked,
 check_status=CASE f.validity WHEN 1 THEN 'valid' WHEN 0 THEN 'invalid' ELSE 'unchecked' END,
 checked_at=f.checked
FROM facts f WHERE r.id=f.resource_id AND (
 r.link_validity IS DISTINCT FROM f.validity OR
 r.link_validity_updated_at IS DISTINCT FROM f.checked OR
 r.checked_at IS DISTINCT FROM f.checked OR
 r.check_status IS DISTINCT FROM CASE f.validity WHEN 1 THEN 'valid' WHEN 0 THEN 'invalid' ELSE 'unchecked' END
)
