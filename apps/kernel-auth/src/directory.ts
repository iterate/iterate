// The directory — the auth worker IS the directory (design §8): users → projects (orgs/devices later).
// One KV-backed implementation, no provider switch. The kernel keeps hostname→project routing; membership
// lives here.

/** A person known to the directory. */
export interface User {
  /** `user:<lowercased-email>`. */
  sub: string;
  email: string;
}

/** A project owned by a user. (Orgs come later; for now owner = a user sub.) */
export interface Project {
  slug: string;
  owner: string;
}

export function directory(kv: KVNamespace) {
  return {
    /** Find-or-create the user for an email. Login is the only writer. */
    async upsertUser(email: string): Promise<User> {
      const sub = `user:${email.trim().toLowerCase()}`;
      const existing = await kv.get<User>(sub, "json");
      if (existing) return existing;
      const user: User = { sub, email: email.trim().toLowerCase() };
      await kv.put(sub, JSON.stringify(user));
      return user;
    },

    /** Projects owned by a user, newest-key-first is not guaranteed — sort by slug. */
    async listProjects(owner: string): Promise<Project[]> {
      const prefix = `project:${owner}:`;
      const listed = await kv.list({ prefix });
      const projects = await Promise.all(listed.keys.map((k) => kv.get<Project>(k.name, "json")));
      return projects
        .filter((p): p is Project => p !== null)
        .sort((a, b) => a.slug.localeCompare(b.slug));
    },

    /** Create a project for a user. Returns the existing one if the slug is taken. */
    async createProject(owner: string, slug: string): Promise<Project> {
      const key = `project:${owner}:${slug}`;
      const existing = await kv.get<Project>(key, "json");
      if (existing) return existing;
      const project: Project = { slug, owner };
      await kv.put(key, JSON.stringify(project));
      return project;
    },
  };
}
