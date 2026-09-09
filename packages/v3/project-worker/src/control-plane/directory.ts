// The directory — the control plane IS the directory. One D1/sqlfu store, strongly consistent (no KV
// list() lag), relational and org-centric: users → orgs (via org_members) → projects. A project's id is
// ONE DNS-safe name (definitions.sql): the directory row, the context DO's name and the project-host
// label — nothing a caller can mint escapes it.

import { createD1Client } from "sqlfu";
import { codedError } from "../lib/errors.ts";
import {
  addOrgMember,
  createOrg,
  createProject,
  getProject,
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
  role?: string;
}
export interface Project {
  id: string; // the DNS-safe name — the DO name and the host label
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

    /** Create an org (a minted org_ id; the name is free text, two orgs may share one) and make the
     *  creator its owner. */
    async createOrg(userId: string, name: string): Promise<Org> {
      const org = await createOrg(client, { id: newOrgId(), name });
      await addOrgMember(client, { orgId: org.id, userId, role: "owner" });
      return { id: org.id, name: org.name, role: "owner" };
    },

    /** Orgs the user belongs to. */
    async listOrgs(userId: string): Promise<Org[]> {
      const rows = await listOrgsForUser(client, { userId });
      return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
    },

    /** Create a project inside an org: `name` slugified IS the id, GLOBALLY unique — a name already
     *  taken in ANY org throws "already taken". Idempotent within the same org (the insert is ON
     *  CONFLICT DO NOTHING, then re-selected to cover both "just created" and "already existed"). */
    async createProject(orgId: string, name: string): Promise<Project> {
      const id = slugify(name);
      if (!id) throw new Error("project name is empty or invalid");
      await createProject(client, { id, orgId });
      const p = await getProject(client, { id });
      if (!p) throw new Error(`failed to create project '${id}'`);
      if (p.orgId !== orgId)
        throw codedError("PROJECT_NAME_TAKEN", `project name '${id}' is already taken`);
      return { id: p.id, orgId: p.orgId };
    },

    /** The user's first org, created as `orgName` (with them as owner) when they have none yet — every
     *  create-a-project door (the console, /authorize, /mcp) goes through here, then `createProject`. */
    async ensureOrg(userId: string, orgName: string): Promise<Org> {
      const orgs = await dir.listOrgs(userId);
      return orgs[0] ?? dir.createOrg(userId, orgName);
    },

    /** Projects the user can reach (member of the owning org), with their role. */
    async listProjects(userId: string): Promise<Project[]> {
      const rows = await listProjectsForUser(client, { userId });
      return rows.map((r) => ({ id: r.id, orgId: r.orgId, role: r.role }));
    },

    /** A project by id (its org), or null — the edge's admission (worker.ts). */
    async getProject(id: string): Promise<Project | null> {
      const p = await getProject(client, { id });
      return p ? { id: p.id, orgId: p.orgId } : null;
    },
  };

  return dir;
}

/** The directory as the edge holds it (src/session.ts). */
export type Directory = ReturnType<typeof directory>;
