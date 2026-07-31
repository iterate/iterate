// The directory — the control plane IS the directory (design §8). One D1/sqlfu store, strongly consistent
// (no KV list() lag), relational and org-centric: users → orgs (via org_members) → projects, plus ingress
// routes owned by projects and API keys. Replaces the kernel's directory.ts provider switch AND routing.ts.

import { createD1Client } from "sqlfu";
import {
  addOrgMember,
  checkProjectAccess,
  createOrg,
  createProject,
  getApiKey,
  getProjectBySlug,
  insertApiKey,
  listOrgsForUser,
  listProjectsForUser,
  listRoutesForProject,
  resolveRoute,
  upsertRoute,
  upsertUser,
} from "../sql/.generated/index.ts";
import { newOrgId, newProjectId, slugify } from "./ids.ts";

export interface User {
  id: string; // user_<lowercased-email>
  email: string;
}
export interface Org {
  id: string; // org_<hex>
  name: string;
  slug: string;
  role?: string;
}
export interface Project {
  id: string;
  slug: string;
  orgId: string;
  role?: string;
}
export interface Grant {
  projectId: string;
  scopes: string[];
}

export function directory(db: D1Database) {
  const client = createD1Client(db);

  const dir = {
    /** Find-or-create the user for an email (login is the only writer). */
    async upsertUser(email: string): Promise<User> {
      const normalized = email.trim().toLowerCase();
      // NB: user id must be colon-free — the OAuth provider encodes tokens as `{userId}:{grantId}:{secret}`
      // and splits on ':'. A `user:<email>` id would break that (and the token/grant KV keys).
      const row = await upsertUser(client, { id: `user_${normalized}`, email: normalized });
      return { id: row.id, email: row.email };
    },

    /** Create an org (minted org_ id + a globally-unique slug) and make the creator its owner. */
    async createOrg(userId: string, name: string, slug: string): Promise<Org> {
      const org = await createOrg(client, { id: newOrgId(), name, slug: slugify(slug) });
      await addOrgMember(client, { orgId: org.id, userId, role: "owner" });
      return { id: org.id, name: org.name, slug: org.slug, role: "owner" };
    },

    /** Orgs the user belongs to. */
    async listOrgs(userId: string): Promise<Org[]> {
      const rows = await listOrgsForUser(client, { userId });
      return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, role: r.role }));
    },

    /**
     * Create a project inside an org. Mints a `prj_` id distinct from the slug; the slug is GLOBALLY
     * unique (mirrors apps/auth) — a slug already taken in ANY org throws "already taken". Idempotent
     * within the same org.
     */
    async createProject(orgId: string, slug: string): Promise<Project> {
      const s = slugify(slug);
      await createProject(client, { id: newProjectId(), slug: s, orgId }); // ON CONFLICT(slug) DO NOTHING
      const p = (await getProjectBySlug(client, { slug: s }))[0];
      if (!p) throw new Error(`failed to create project '${s}'`);
      if (p.orgId !== orgId) throw new Error(`project slug '${s}' is already taken`);
      return { id: p.id, slug: p.slug, orgId: p.orgId };
    },

    /**
     * Emerge with an org + project in one shot — the "create org + project during MCP /authorize" flow
     * (ADR 0029). The org's slug is the project slug (globally unique, so the org slug is unique too).
     */
    async emerge(
      userId: string,
      orgName: string,
      slug: string,
    ): Promise<{ org: Org; project: Project }> {
      const s = slugify(slug);
      const org = await dir.createOrg(userId, orgName, s);
      const project = await dir.createProject(org.id, s);
      return { org, project };
    },

    /** Ensure the user has at least one org; returns their first (creating a personal one if none). */
    async ensureOrg(userId: string, email: string): Promise<Org> {
      const orgs = await dir.listOrgs(userId);
      return orgs[0] ?? dir.createOrg(userId, `${email}'s org`, slugify(email));
    },

    /** Projects the user can reach (member of the owning org), with their role. */
    async listProjects(userId: string): Promise<Project[]> {
      const rows = await listProjectsForUser(client, { userId });
      return rows.map((r) => ({ id: r.id, slug: r.slug, orgId: r.orgId, role: r.role }));
    },

    /** Resolve a project by slug (id + org), or null. */
    async getBySlug(slug: string): Promise<Project | null> {
      const p = (await getProjectBySlug(client, { slug }))[0];
      return p ? { id: p.id, slug: p.slug, orgId: p.orgId } : null;
    },

    /** Authorize a user against a project — membership in the project's org. */
    async access(userId: string, projectId: string): Promise<{ ok: boolean; role?: string }> {
      const m = (await checkProjectAccess(client, { projectId, userId }))[0];
      return m ? { ok: true, role: m.role } : { ok: false };
    },

    /** Hostname → project routing (replaces routing.ts). null if the host isn't registered. */
    async resolveRoute(host: string): Promise<{ projectId: string; app: string } | null> {
      const r = await resolveRoute(client, { host });
      return r ? { projectId: r.projectId, app: r.app } : null;
    },

    /** The routes (ingress hostnames) a project owns. */
    async listRoutes(projectId: string): Promise<{ host: string; app: string }[]> {
      return listRoutesForProject(client, { projectId });
    },

    /** Point an ingress hostname at a project (a project property). */
    async upsertRoute(host: string, projectId: string, app = ""): Promise<void> {
      await upsertRoute(client, { host, projectId, app });
    },

    /** Store an API key (hashed) with its project grants. */
    async createApiKey(
      hash: string,
      userId: string,
      label: string,
      grants: Grant[],
    ): Promise<void> {
      await insertApiKey(client, { hash, userId, label, grants: JSON.stringify(grants) });
    },

    /** Resolve an API key hash → { actor, grants }, or null. */
    async resolveApiKey(hash: string): Promise<{ userId: string; grants: Grant[] } | null> {
      const row = await getApiKey(client, { hash });
      if (!row) return null;
      return { userId: row.userId, grants: JSON.parse(row.grants) as Grant[] };
    },
  };

  return dir;
}
