-- 065: Amazon's business units in the CDO's report order (Crane West, Crane IFS, Sarus), which the BU
-- tabs, cards and trends follow. Only while the units still sit in the seed's old order (Crane IFS
-- first), so an order set on the Admin page stays as it is.

UPDATE ops.account_segment s
SET sort = o.sort
FROM (VALUES ('Crane West', 1), ('Crane IFS', 2), ('Sarus', 3), ('Crane Southwest', 4)) AS o (name, sort)
WHERE s.account_slug = 'amazon' AND s.name = o.name
  AND EXISTS (SELECT 1 FROM ops.account_segment x WHERE x.account_slug = 'amazon' AND x.name = 'Crane IFS' AND x.sort = 1);
