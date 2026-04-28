SELECT 1 AS present
FROM resources
WHERE type = :type
LIMIT 1;
