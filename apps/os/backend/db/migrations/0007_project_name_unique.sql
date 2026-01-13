-- a cte which checks for duplicated names and adds a random suffix to the name to allow adding a unique index after

WITH duplicated_names AS (
  SELECT name, organization_id, COUNT(*)
  FROM project
  GROUP BY name, organization_id
  HAVING COUNT(*) > 1
)
SELECT name, organization_id, ROW_NUMBER() OVER (PARTITION BY name, organization_id ORDER BY id) as row_number
FROM project
WHERE name IN (SELECT name FROM duplicated_names);


CREATE UNIQUE INDEX "project_organization_id_name_index" ON "project" USING btree ("organization_id","name");
