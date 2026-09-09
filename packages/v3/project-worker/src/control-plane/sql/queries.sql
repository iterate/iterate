-- Control-plane directory queries — the single source of vanilla SQL for the control plane.
-- sqlfu best practice: one named query per statement (`/** @name x */`), `:named` bind params, explicit
-- column lists (no SELECT *). `sqlfu generate` types these into sql/.generated/. Schema: ../definitions.sql.

-- ── Users ────────────────────────────────────────────────────────────────────────────────────────────

/** @name upsertUser */
INSERT INTO users (id, email) VALUES (:id, :email)
ON CONFLICT(id) DO UPDATE SET email = excluded.email
RETURNING id, email;

-- ── Orgs + membership (access to a project = membership in its org) ───────────────────────────────────

/** @name createOrg */
INSERT INTO orgs (id, name) VALUES (:id, :name)
RETURNING id, name;

/** @name addOrgMember */
INSERT INTO org_members (org_id, user_id, role) VALUES (:orgId, :userId, :role)
ON CONFLICT(org_id, user_id) DO NOTHING;

/** @name listOrgsForUser */
SELECT o.id, o.name, m.role
FROM orgs o
JOIN org_members m ON m.org_id = o.id
WHERE m.user_id = :userId
ORDER BY o.name ASC;

-- ── Projects (the id is ONE DNS-safe name — the directory row, the DO, and the host label) ──────────

/** @name createProject */
INSERT INTO projects (id, org_id) VALUES (:id, :orgId)
ON CONFLICT DO NOTHING;

/** @name getProject */
SELECT id, org_id FROM projects WHERE id = :id;

/** @name listProjectsForUser */
SELECT p.id, p.org_id, m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE m.user_id = :userId
ORDER BY p.id ASC;
