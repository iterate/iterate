import { codedError } from "iterate/next/lib";

// ── directory ── the control plane IS the directory. One D1 store, strongly consistent (no KV
// list() lag), relational and org-centric: users → orgs (via org_members) → projects. A project is
// addressed by its minted id everywhere (control-plane.sql): the context DO's name, a grant's list,
// the API; its slug is the label of its hostnames and its name to a person — nothing a caller can
// mint escapes the id. The statements below are the control plane's whole SQL, each spelled once at
// its one call site and bound positionally; the three row interfaces are the rows D1 hands back
// (`org_id` is selected `AS orgId`).

/** A `users` row. */
export interface User {
  id: string; // Stable, opaque user id; email can change.
  email: string;
}
/** An `orgs` row, with the reader's `role` when read through `org_members`. */
export interface Org {
  id: string; // org_<hex>
  name: string;
  role?: string;
  /** how many projects it holds — every one of them, not only those the reader's grant lists */
  projects: number;
}
/** A `projects` row, with the reader's `role` when read through `org_members`. */
export interface Project {
  id: string; // prj_<hex>, minted — the DO name's host, the kv/secret prefix, what a grant names
  slug: string; // the DNS label of its hostnames (`<app>--<slug>.<base>`), unique; a name, not an address
  orgId: string;
  role?: string;
}

/** A project's slug from its name — the ONE slugging (`createProject` here): lowercase,
 *  non-alphanumeric → dash, runs collapsed, ends trimmed. Empty when nothing DNS-safe survives. */
export const projectSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Membership-derived access, optionally capped to selected projects. The
 * administrator alone reaches every project; explicit empty selections reach none. */
export type Reach = "every" | { userId: string; projectIds?: string[] } | { projectIds: string[] };

/** `reach`, for a refusal's message (session.ts `projects.get`, `createProject`). */
export const describeReach = (reach: Reach): string =>
  reach === "every"
    ? "every project"
    : "userId" in reach
      ? `the projects of the orgs ${reach.userId} belongs to`
      : `bound to ${reach.projectIds.map((projectId) => JSON.stringify(projectId)).join(", ") || "no project"}`;

/** `org_<32hex>`. */
const newOrgId = () => `org_${crypto.randomUUID().replaceAll("-", "")}`;

export function directory(db: D1Database) {
  const d1Directory = {
    /** Find-or-create the user for an email (login is the only writer). */
    async upsertUser(email: string, verifiedId?: string): Promise<User> {
      const normalized = email.trim().toLowerCase();
      // NB: user id must be colon-free — the OAuth provider encodes tokens as `{userId}:{grantId}:{secret}`
      // and splits on ':'. A `user:<email>` id would break that (and the token/grant KV keys).
      const user = await db
        .prepare(
          `INSERT INTO users (id, email) VALUES (?, ?)
ON CONFLICT(email) DO UPDATE SET email = excluded.email
RETURNING id, email;`,
        )
        .bind(verifiedId || `user_${crypto.randomUUID()}`, normalized)
        .first<User>();
      return user!;
    },

    /** Link once by verified email, then resolve by Google's stable subject.
     * A different Google identity cannot adopt an already-linked account. */
    async upsertGoogleUser(subject: string, email: string): Promise<User> {
      const normalized = email.trim().toLowerCase();
      const lookup = () =>
        db
          .prepare("SELECT user_id FROM google_identities WHERE subject = ?")
          .bind(subject)
          .first<{ user_id: string }>();
      let identity = await lookup();
      if (!identity) {
        const user = await d1Directory.upsertUser(normalized, `user_google_${subject}`);
        await db
          .prepare(
            "INSERT INTO google_identities (subject, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
          )
          .bind(subject, user.id)
          .run();
        identity = await lookup();
      }
      if (!identity)
        throw codedError("IDENTITY_CONFLICT", "This email belongs to another linked account.");
      const user = await db
        .prepare(`UPDATE users SET email = ? WHERE id = ?
AND NOT EXISTS (SELECT 1 FROM users WHERE email = ? AND id != ?) RETURNING id, email`)
        .bind(normalized, identity.user_id, normalized, identity.user_id)
        .first<User>();
      if (!user) throw codedError("IDENTITY_CONFLICT", "This email belongs to another account.");
      return user;
    },

    /** Create an org (a minted org_ id; the name is free text, two orgs may share one) and make the
     *  creator its owner. */
    async createOrg(userId: string, name: string): Promise<Org> {
      const org = { id: newOrgId(), name: name.trim(), role: "owner", projects: 0 };
      if (!org.name) throw codedError("INVALID_INPUT", "Enter an organization name.");
      // D1 batch is transactional: an organization never survives without its owner.
      await db.batch([
        db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").bind(org.id, org.name),
        db
          .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)")
          .bind(org.id, userId, org.role),
      ]);
      return org;
    },

    /** Rename an org — its owner's to do; the name stays free text. */
    async renameOrg(userId: string, orgId: string, name: string): Promise<Org> {
      const trimmed = name.trim();
      if (!trimmed) throw codedError("INVALID_INPUT", "Enter an organization name.");
      const org = (await d1Directory.listOrgs(userId)).find((entry) => entry.id === orgId);
      if (org?.role !== "owner")
        throw codedError("FORBIDDEN", "Only an owner can rename an organization.");
      await db.prepare("UPDATE orgs SET name = ? WHERE id = ?").bind(trimmed, orgId).run();
      return { ...org, name: trimmed };
    },

    /** Delete an org — its owner's to do, and only while it holds no project (a project is its
     *  organization's; nothing here deletes one). The memberships go with it. */
    async deleteOrg(userId: string, orgId: string): Promise<void> {
      const org = (await d1Directory.listOrgs(userId)).find((entry) => entry.id === orgId);
      if (org?.role !== "owner")
        throw codedError("FORBIDDEN", "Only an owner can delete an organization.");
      const held = await db
        .prepare("SELECT count(*) AS n FROM projects WHERE org_id = ?")
        .bind(orgId)
        .first<{ n: number }>();
      if (held?.n)
        throw codedError(
          "INVALID_INPUT",
          `This organization still holds ${held.n} project${held.n === 1 ? "" : "s"}.`,
        );
      // D1 batch is transactional: the memberships and the organization go together.
      await db.batch([
        db.prepare("DELETE FROM org_members WHERE org_id = ?").bind(orgId),
        db.prepare("DELETE FROM orgs WHERE id = ?").bind(orgId),
      ]);
    },

    /** Orgs the user belongs to. */
    async listOrgs(userId: string): Promise<Org[]> {
      const { results } = await db
        .prepare(
          `SELECT o.id, o.name, m.role, (SELECT count(*) FROM projects p WHERE p.org_id = o.id) AS projects
FROM orgs o
JOIN org_members m ON m.org_id = o.id
WHERE m.user_id = ?
ORDER BY o.name ASC;`,
        )
        .bind(userId)
        .all<Org>();
      return results;
    },

    /** Create the project slugged from `name` — a minted id, the slug globally unique — in the
     * selected member organization. Without a selection, use the user's first/default organization
     * or the admin organization. Fixed project grants cannot create projects. Repeating a name in
     * its owning organization is idempotent (the row comes back); another organization is refused. */
    async createProject(reach: Reach, name: string, orgId?: string): Promise<Project> {
      if (typeof reach === "object" && "projectIds" in reach)
        throw codedError(
          "FORBIDDEN",
          `this session is ${describeReach(reach)} — creating a project needs a signed-in user or the admin secret`,
        );
      const slug = projectSlug(name);
      if (!slug) throw new Error("project name is empty or invalid");
      let org: Org | null | undefined;
      if (orgId)
        org =
          reach === "every"
            ? await db
                .prepare(
                  `SELECT o.id, o.name, (SELECT count(*) FROM projects p WHERE p.org_id = o.id) AS projects
FROM orgs o WHERE o.id = ?;`,
                )
                .bind(orgId)
                .first<Org>()
            : (await d1Directory.listOrgs(reach.userId)).find((entry) => entry.id === orgId);
      else
        org =
          reach === "every"
            ? await d1Directory.adminOrg()
            : await d1Directory.ensureOrg(reach.userId);
      if (!org) throw codedError("FORBIDDEN", "You cannot create a project in that organization.");
      const existing = await d1Directory.getProject(slug);
      if (existing) {
        if (existing.orgId !== org.id)
          throw codedError("PROJECT_NAME_TAKEN", `project name '${slug}' is already taken`);
        return existing;
      }
      const id = `prj_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await db
          .prepare(`INSERT INTO projects (id, slug, org_id) VALUES (?, ?, ?);`)
          .bind(id, slug, org.id)
          .run();
        return { id, slug, orgId: org.id };
      } catch (error) {
        // two creates racing on one slug: the unique slug refuses the second, which reads the first
        if (!/UNIQUE constraint failed: projects\.slug/.test(String(error))) throw error;
        const winner = await d1Directory.getProject(slug);
        if (!winner || winner.orgId !== org.id)
          throw codedError("PROJECT_NAME_TAKEN", `project name '${slug}' is already taken`);
        return winner;
      }
    },

    /** The user's first org — named after their email's local part (`jonas` for jonas@…), with them
     *  as owner — made when they have none yet: a first project created without naming one (the
     *  consent page's "Create your first project", the dash's first "New project"). */
    async ensureOrg(userId: string): Promise<Org> {
      const orgs = await d1Directory.listOrgs(userId);
      if (orgs[0]) return orgs[0];
      const user = await db
        .prepare(`SELECT id, email FROM users WHERE id = ?;`)
        .bind(userId)
        .first<User>();
      return d1Directory.createOrg(userId, user!.email.split("@")[0]!);
    },

    /** Projects the user can reach (member of the owning org), with their role. */
    async listProjects(userId: string): Promise<Project[]> {
      const { results } = await db
        .prepare(
          `SELECT p.id, p.slug, p.org_id AS orgId, m.role
FROM projects p
JOIN org_members m ON m.org_id = p.org_id
WHERE m.user_id = ?
ORDER BY p.slug ASC;`,
        )
        .bind(userId)
        .all<Project>();
      return results;
    },

    /** A project by id or by slug — THE lookup: a URL's `/projects/<slug>`, a hostname's label, an
     *  API call's `project`, a grant's id all resolve here, and nothing else tells the two apart
     *  (a slug never spells `prj_…`). Null when the directory has neither. */
    async getProject(ref: string): Promise<Project | null> {
      return db
        .prepare(`SELECT id, slug, org_id AS orgId FROM projects WHERE id = ? OR slug = ?;`)
        .bind(ref, ref)
        .first<Project>();
    },

    /** EVERY project in the directory, no role — the admin secret's catalog. */
    async listAllProjects(): Promise<Project[]> {
      const { results } = await db
        .prepare(`SELECT id, slug, org_id AS orgId FROM projects ORDER BY slug ASC;`)
        .all<Project>();
      return results;
    },

    /** The projects `reach` reaches, as directory rows: every project for the admin secret; the
     *  user's, with their role; the named ones (their rows — a name the directory never heard of
     *  is no row). */
    async reachableProjects(reach: Reach): Promise<Project[]> {
      if (reach === "every") return d1Directory.listAllProjects();
      if ("userId" in reach) {
        const projects = await d1Directory.listProjects(reach.userId);
        return reach.projectIds
          ? projects.filter((project) => reach.projectIds!.includes(project.id))
          : projects;
      }
      const rows = await Promise.all(
        reach.projectIds.map((projectId) => d1Directory.getProject(projectId)),
      );
      return rows.filter((row): row is Project => !!row);
    },

    /** Whether `reach` reaches `projectId` — the admission behind `projects.get` (session.ts) and a
     *  `/mcp` tool's `project`. The admin reaches a project the directory never heard of (the door
     *  is the admin's); a named reach is its list; a user's is one membership read. */
    /** The id a ref names: an id is self-evident (`prj_…` — a slug never holds an underscore), a
     *  slug resolves through the directory, and a slug it lacks passes through for the reach check
     *  to refuse. The ONE slug-or-id rule (`projects.get`, the MCP `project`, every reach check). */
    async projectIdOf(ref: string): Promise<string> {
      if (ref.startsWith("prj_")) return ref;
      return (await d1Directory.getProject(ref))?.id ?? ref;
    },

    async reachesProject(reach: Reach, ref: string): Promise<boolean> {
      if (reach === "every") return true;
      const id = await d1Directory.projectIdOf(ref);
      if (reach.projectIds && !reach.projectIds.includes(id)) return false;
      if (!("userId" in reach)) return true;
      return (await d1Directory.listProjects(reach.userId)).some((row) => row.id === id);
    },

    /** The deployment's own org — `org_admin`, created on first use, no members: where the admin
     *  secret's `projects.create` puts a project (a user reaches one only through the admin secret
     *  or its `as`). */
    async adminOrg(): Promise<Org> {
      await db
        .prepare(
          `INSERT INTO orgs (id, name) VALUES ('org_admin', 'admin') ON CONFLICT DO NOTHING;`,
        )
        .run();
      const row = await db
        .prepare(
          `SELECT o.id, o.name, (SELECT count(*) FROM projects p WHERE p.org_id = o.id) AS projects
FROM orgs o WHERE o.id = 'org_admin';`,
        )
        .first<Org>();
      return row!;
    },
  };

  return d1Directory;
}

/** The directory as the edge holds it (src/session.ts). */
export type Directory = ReturnType<typeof directory>;
