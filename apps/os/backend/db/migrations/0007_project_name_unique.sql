-- a cte which checks for duplicated names and adds a random suffix to the name to allow adding a unique index after

WITH duplicated_names AS (
  SELECT name, organization_id, COUNT(*)
  FROM project
  GROUP BY name, organization_id
  HAVING COUNT(*) > 1
),
new_names as (
    SELECT name, organization_id, ROW_NUMBER() OVER (PARTITION BY name, organization_id ORDER BY id) as row_number
    FROM project
    WHERE name IN (SELECT name FROM duplicated_names)
)
update project
set name = name || '-' || row_number
from new_names
where project.name = new_names.name
and project.organization_id = new_names.organization_id;

CREATE UNIQUE INDEX "project_organization_id_name_index" ON "project" USING btree ("organization_id","name");
