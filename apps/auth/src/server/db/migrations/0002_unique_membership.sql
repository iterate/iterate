DELETE FROM member
WHERE id NOT IN (
  SELECT id
  FROM (
    SELECT id,
      row_number() OVER (
        PARTITION BY "organizationId", "userId"
        ORDER BY CASE role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          ELSE 2
        END ASC,
        "createdAt" ASC,
        id ASC
      ) AS row_number
    FROM member
  )
  WHERE row_number = 1
);

CREATE UNIQUE INDEX member_organizationId_userId_uidx
ON member ("organizationId", "userId");

