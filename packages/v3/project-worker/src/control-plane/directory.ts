// The directory — the control plane IS the directory. One D1/sqlfu store, strongly consistent (no KV
// list() lag), relational and org-centric: users → orgs (via org_members) → projects. A project's id IS
// its slug (definitions.sql): one DNS-safe name is the directory row, the context DO's name and the
// project-host label — nothing a caller can mint escapes it.

import { createD1Client } from "sqlfu";
import {
  addOrgMember,
  createOrg,
  createProject,
  getProjectBySlug,
  listOrgsForUser,
  listProjectsForUser,
  upsertUser,
} from "./sql/.generated/index.ts";
import { newOrgId, slugify } from "./ids.ts";

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
  id: string; // === slug
  slug: string;
  orgId: string;
  role?: string;
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

    /** Create an org (minted org_ id + a collision-proof slug) and make the creator its owner. The slug is
     *  suffixed with the id tail so two orgs of the same name never collide on the unique constraint. */
    async createOrg(userId: string, name: string): Promise<Org> {
      const id = newOrgId();
      const slug = `${slugify(name).slice(0, 32) || "org"}-${id.slice(-6)}`;
      const org = await createOrg(client, { id, name, slug });
      await addOrgMember(client, { orgId: org.id, userId, role: "owner" });
      return { id: org.id, name: org.name, slug: org.slug, role: "owner" };
    },

    /** Orgs the user belongs to. */
    async listOrgs(userId: string): Promise<Org[]> {
      const rows = await listOrgsForUser(client, { userId });
      return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, role: r.role }));
    },

    /** Create a project inside an org. The slug is normalized and IS the id; it is GLOBALLY unique — a
     *  slug already taken in ANY org throws "already taken". Idempotent within the same org (the insert
     *  is ON CONFLICT DO NOTHING, then re-selected to cover both "just created" and "already existed"). */
    async createProject(orgId: string, slug: string): Promise<Project> {
      const s = slugify(slug);
      if (!s) throw new Error("project slug is empty or invalid");
      await createProject(client, { id: s, slug: s, orgId });
      const p = (await getProjectBySlug(client, { slug: s }))[0];
      if (!p) throw new Error(`failed to create project '${s}'`);
      if (p.orgId !== orgId) throw new Error(`project slug '${s}' is already taken`);
      return { id: p.id, slug: p.slug, orgId: p.orgId };
    },

    /** Emerge with an org + project — the "create a project during MCP /authorize" flow (ADR 0029). REUSES
     *  the caller's existing org when they have one; creates one named `orgName` only on first use. The
     *  single create-a-project path (all surfaces route here). Not atomic across org/member/project. */
    async emerge(
      userId: string,
      orgName: string,
      slug: string,
    ): Promise<{ org: Org; project: Project }> {
      const existing = (await dir.listOrgs(userId))[0];
      const org = existing ?? (await dir.createOrg(userId, orgName));
      const project = await dir.createProject(org.id, slug);
      return { org, project };
    },

    /** Ensure the user has at least one org; returns their first (creating a personal one if none). */
    async ensureOrg(userId: string, email: string): Promise<Org> {
      const orgs = await dir.listOrgs(userId);
      return orgs[0] ?? dir.createOrg(userId, `${email}'s org`);
    },

    /** Projects the user can reach (member of the owning org), with their role. */
    async listProjects(userId: string): Promise<Project[]> {
      const rows = await listProjectsForUser(client, { userId });
      return rows.map((r) => ({ id: r.id, slug: r.slug, orgId: r.orgId, role: r.role }));
    },

    /** Resolve a project by slug (its id + org), or null — the edge's admission (worker.ts). */
    async getBySlug(slug: string): Promise<Project | null> {
      const p = (await getProjectBySlug(client, { slug }))[0];
      return p ? { id: p.id, slug: p.slug, orgId: p.orgId } : null;
    },
  };

  return dir;
}
