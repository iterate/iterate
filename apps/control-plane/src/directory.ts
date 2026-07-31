// The directory — the control plane IS the directory (design §8). One D1/sqlfu store, strongly consistent
// (no KV list() lag), relational: users → projects via memberships, plus ingress routes owned by projects
// and API keys. Replaces the kernel's directory.ts provider switch AND its routing.ts config/KV lookup.

import { createD1Client } from "sqlfu";
import {
  addMembership,
  checkMembership,
  createProject,
  getApiKey,
  getProjectBySlug,
  insertApiKey,
  listProjectsForUser,
  listRoutesForProject,
  resolveRoute,
  upsertRoute,
  upsertUser,
} from "../sql/.generated/index.ts";

/** A person known to the directory. */
export interface User {
  /** `user:<lowercased-email>`. */
  id: string;
  email: string;
}

/** A project, optionally with the caller's role when reached through membership. */
export interface Project {
  id: string;
  slug: string;
  role?: string;
}

/** A grant an API key carries. */
export interface Grant {
  projectId: string;
  scopes: string[];
}

export function directory(db: D1Database) {
  const client = createD1Client(db);
  return {
    /** Find-or-create the user for an email (login is the only writer). */
    async upsertUser(email: string): Promise<User> {
      const normalized = email.trim().toLowerCase();
      const row = await upsertUser(client, { id: `user:${normalized}`, email: normalized });
      return { id: row.id, email: row.email };
    },

    /** Projects the user is a member of, with their role. */
    async listProjects(userId: string): Promise<Project[]> {
      const rows = await listProjectsForUser(client, { userId });
      return rows.map((r) => ({ id: r.id, slug: r.slug, role: r.role }));
    },

    /** Create a project (idempotent on slug) and make the creator its owner. */
    async createProject(userId: string, slug: string): Promise<Project> {
      await createProject(client, { id: slug, slug }); // ON CONFLICT DO NOTHING
      const found = await getProjectBySlug(client, { slug });
      const project = found[0];
      if (!project) throw new Error(`failed to create project '${slug}'`);
      await addMembership(client, { projectId: project.id, userId, role: "owner" });
      return { id: project.id, slug: project.slug };
    },

    /** Authorize a user against a project — the enforcement the kernel's ProjectCollection needs. */
    async access(userId: string, projectId: string): Promise<{ ok: boolean; role?: string }> {
      const m = await checkMembership(client, { projectId, userId });
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
}
