-- Control-plane directory queries — the single source of vanilla SQL for the control plane.
-- sqlfu best practice: one named query per statement (`/** @name x */`), `:named` bind params, explicit
-- column lists (no SELECT *). `sqlfu generate` types these into sql/.generated/ and the worker calls them
-- as `await queryName(createD1Client(env.DB), params)`. Schema lives in ../definitions.sql.

-- ── Users ────────────────────────────────────────────────────────────────────────────────────────────

/** @name upsertUser */
INSERT INTO users (id, email) VALUES (:id, :email)
ON CONFLICT(id) DO UPDATE SET email = excluded.email
RETURNING id, email;

/** @name getUserByEmail */
SELECT id, email FROM users WHERE email = :email;

-- ── Projects ─────────────────────────────────────────────────────────────────────────────────────────

/** @name createProject */
INSERT INTO projects (id, slug) VALUES (:id, :slug)
ON CONFLICT(slug) DO NOTHING
RETURNING id, slug;

/** @name getProjectBySlug */
SELECT id, slug FROM projects WHERE slug = :slug;

-- ── Memberships (who can access which project) ───────────────────────────────────────────────────────

/** @name addMembership */
INSERT INTO memberships (project_id, user_id, role) VALUES (:projectId, :userId, :role)
ON CONFLICT(project_id, user_id) DO NOTHING;

/** @name listProjectsForUser */
SELECT p.id, p.slug, m.role
FROM projects p
JOIN memberships m ON m.project_id = p.id
WHERE m.user_id = :userId
ORDER BY p.slug ASC;

/** @name checkMembership */
SELECT role FROM memberships WHERE project_id = :projectId AND user_id = :userId;

-- ── Routes (ingress hostnames owned by a project) ────────────────────────────────────────────────────

/** @name resolveRoute */
SELECT project_id, app FROM routes WHERE host = :host;

/** @name upsertRoute */
INSERT INTO routes (host, project_id, app) VALUES (:host, :projectId, :app)
ON CONFLICT(host) DO UPDATE SET project_id = excluded.project_id, app = excluded.app;

/** @name listRoutesForProject */
SELECT host, app FROM routes WHERE project_id = :projectId ORDER BY host ASC;

-- ── API keys (bearer credentials scoped to projects; store the hash, never the raw key) ───────────────

/** @name insertApiKey */
INSERT INTO api_keys (hash, user_id, label, grants) VALUES (:hash, :userId, :label, :grants);

/** @name getApiKey */
SELECT hash, user_id, label, grants FROM api_keys WHERE hash = :hash;

/** @name listApiKeysForUser */
SELECT hash, label, grants, created_at FROM api_keys WHERE user_id = :userId ORDER BY created_at DESC;

/** @name deleteApiKey */
DELETE FROM api_keys WHERE hash = :hash AND user_id = :userId;
