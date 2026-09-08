-- Control-plane directory queries — the single source of vanilla SQL for the control plane.
-- sqlfu best practice: one named query per statement (`/** @name x */`), `:named` bind params, explicit
-- column lists (no SELECT *). `sqlfu generate` types these into sql/.generated/. Schema: ../definitions.sql.

-- ── Users ────────────────────────────────────────────────────────────────────────────────────────────

/** @name upsertUser */
INSERT INTO users (id, email) VALUES (:id, :email)
ON CONFLICT(id) DO UPDATE SET email = excluded.email
RETURNING id, email;

/** @name getUserByEmail */
SELECT id, email FROM users WHERE email = :email;

-- ── Orgs + membership (access to a project = membership in its org) ───────────────────────────────────

/** @name createOrg */
INSERT INTO orgs (id, name, slug) VALUES (:id, :name, :slug)
RETURNING id, name, slug;

/** @name addOrgMember */
INSERT INTO org_members (org_id, user_id, role) VALUES (:orgId, :userId, :role)
ON CONFLICT(org_id, user_id) DO NOTHING;

/** @name listOrgsForUser */
SELECT o.id, o.name, o.slug, m.role
FROM orgs o
JOIN org_members m ON m.org_id = o.id
WHERE m.user_id = :userId
ORDER BY o.name ASC;

-- ── Projects ─────────────────────────────────────────────────────────────────────────────────────────

/** @name createProject */
INSERT INTO projects (id, slug, org_id) VALUES (:id, :slug, :orgId)
ON CONFLICT(slug) DO NOTHING;

/** @name getProjectBySlug */
SELECT id, slug, org_id FROM projects WHERE slug = :slug;

/** @name listProjectsForUser */
SELECT p.id, p.slug, p.org_id, m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE m.user_id = :userId
ORDER BY p.slug ASC;

/** @name checkProjectAccess */
SELECT m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE p.id = :projectId AND m.user_id = :userId;

-- ── Routes (ingress hostnames owned by a project) ────────────────────────────────────────────────────

/** @name resolveRoute */
SELECT project_id, app FROM routes WHERE host = :host;

/** @name upsertRoute */
INSERT INTO routes (host, project_id, app) VALUES (:host, :projectId, :app)
ON CONFLICT(host) DO UPDATE SET project_id = excluded.project_id, app = excluded.app;

/** @name listRoutesForProject */
SELECT host, app FROM routes WHERE project_id = :projectId ORDER BY host ASC;

-- ── API keys (bearer creds scoped to projects; store the hash, never the raw key) ─────────────────────

/** @name insertApiKey */
INSERT INTO api_keys (hash, user_id, label, grants) VALUES (:hash, :userId, :label, :grants);

/** @name getApiKey */
SELECT hash, user_id, label, grants FROM api_keys WHERE hash = :hash;

/** @name listApiKeysForUser */
SELECT hash, label, grants, created_at FROM api_keys WHERE user_id = :userId ORDER BY created_at DESC;

/** @name deleteApiKey */
DELETE FROM api_keys WHERE hash = :hash AND user_id = :userId;
