// The directory — the control plane IS the directory. One D1 store, strongly consistent (no KV
// list() lag), relational and org-centric: users → orgs (via org_members) → projects. A project's id is
// ONE DNS-safe name (definitions.sql): the directory row, the context DO's name and the project-host
// label — nothing a caller can mint escapes it. The statements below are the control plane's whole
// SQL, each spelled once at its one call site and bound positionally; the three row interfaces are
// the rows D1 hands back (`org_id` is selected `AS orgId`).

import { codedError } from "../lib/errors.ts";

/** A `users` row. */
export interface User {
  id: string; // user_<lowercased-email>
  email: string;
}
/** An `orgs` row, with the reader's `role` when read through `org_members`. */
export interface Org {
  id: string; // org_<hex>
  name: string;
  role?: string;
}
/** A `projects` row, with the reader's `role` when read through `org_members`. */
export interface Project {
  id: string; // the DNS-safe name — the DO name and the host label
  orgId: string;
  role?: string;
}

/** Slugify as @iterate-com/shared/slug normalizes (lowercase, non-alphanumeric → dash, trimmed). A
 *  PROJECT has no minted id — its slug IS its id; an org has no slug at all. */
export const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/** `org_<32hex>`. */
const newOrgId = () => `org_${crypto.randomUUID().replaceAll("-", "")}`;

export function directory(db: D1Database) {
  const dir = {
    /** Find-or-create the user for an email (login is the only writer). */
    async upsertUser(email: string): Promise<User> {
      const normalized = email.trim().toLowerCase();
      // NB: user id must be colon-free — the OAuth provider encodes tokens as `{userId}:{grantId}:{secret}`
      // and splits on ':'. A `user:<email>` id would break that (and the token/grant KV keys).
      const user = await db
        .prepare(
          `INSERT INTO users (id, email) VALUES (?, ?)
ON CONFLICT(id) DO UPDATE SET email = excluded.email
RETURNING id, email;`,
        )
        .bind(`user_${normalized}`, normalized)
        .first<User>();
      return user!;
    },

    /** Create an org (a minted org_ id; the name is free text, two orgs may share one) and make the
     *  creator its owner. */
    async createOrg(userId: string, name: string): Promise<Org> {
      const org = await db
        .prepare(
          `INSERT INTO orgs (id, name) VALUES (?, ?)
RETURNING id, name;`,
        )
        .bind(newOrgId(), name)
        .first<Org>();
      await db
        .prepare(
          `INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)
ON CONFLICT(org_id, user_id) DO NOTHING;`,
        )
        .bind(org!.id, userId, "owner")
        .run();
      return { ...org!, role: "owner" };
    },

    /** Orgs the user belongs to. */
    async listOrgs(userId: string): Promise<Org[]> {
      const { results } = await db
        .prepare(
          `SELECT o.id, o.name, m.role
FROM orgs o
JOIN org_members m ON m.org_id = o.id
WHERE m.user_id = ?
ORDER BY o.name ASC;`,
        )
        .bind(userId)
        .all<Org>();
      return results;
    },

    /** Create a project inside an org: `name` slugified IS the id, GLOBALLY unique — a name already
     *  taken in ANY org throws "already taken". Idempotent within the same org (the insert is ON
     *  CONFLICT DO NOTHING, then re-selected to cover both "just created" and "already existed"). */
    async createProject(orgId: string, name: string): Promise<Project> {
      const id = slugify(name);
      if (!id) throw new Error("project name is empty or invalid");
      await db
        .prepare(
          `INSERT INTO projects (id, org_id) VALUES (?, ?)
ON CONFLICT DO NOTHING;`,
        )
        .bind(id, orgId)
        .run();
      const project = await dir.getProject(id);
      if (!project) throw new Error(`failed to create project '${id}'`);
      if (project.orgId !== orgId)
        throw codedError("PROJECT_NAME_TAKEN", `project name '${id}' is already taken`);
      return project;
    },

    /** The user's first org, created as `orgName` (with them as owner) when they have none yet — every
     *  create-a-project door (the console, /authorize, /mcp) goes through here, then `createProject`. */
    async ensureOrg(userId: string, orgName: string): Promise<Org> {
      const orgs = await dir.listOrgs(userId);
      return orgs[0] ?? dir.createOrg(userId, orgName);
    },

    /** Projects the user can reach (member of the owning org), with their role. */
    async listProjects(userId: string): Promise<Project[]> {
      const { results } = await db
        .prepare(
          `SELECT p.id, p.org_id AS orgId, m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE m.user_id = ?
ORDER BY p.id ASC;`,
        )
        .bind(userId)
        .all<Project>();
      return results;
    },

    /** A project by id (its org), or null — the edge's admission (worker.ts). */
    async getProject(id: string): Promise<Project | null> {
      return db
        .prepare(`SELECT id, org_id AS orgId FROM projects WHERE id = ?;`)
        .bind(id)
        .first<Project>();
    },
  };

  return dir;
}

/** The directory as the edge holds it (src/session.ts). */
export type Directory = ReturnType<typeof directory>;
