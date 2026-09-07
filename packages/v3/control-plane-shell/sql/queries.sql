-- The control plane's queries — one named statement each, `:named` params, explicit columns. `sqlfu generate`
-- types them into sql/.generated/ against ../definitions.sql.

/** @name projectExists */
SELECT id FROM projects WHERE id = :id;

/** @name createProject */
INSERT INTO projects (id) VALUES (:id)
ON CONFLICT(id) DO NOTHING
RETURNING id, created_at;

/** @name listProjects */
SELECT id, created_at FROM projects ORDER BY created_at DESC LIMIT :limit;
