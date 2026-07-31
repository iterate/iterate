// The capnweb `/api` — the control plane's ONE typed API, the sibling of `/mcp` (both are the front desk).
// Os.authenticate() is the only door (design §"/api"): it resolves the caller from the SESSION cookie or an
// API-key bearer against the D1 directory — NOT OAuth (OAuth stays at /mcp). Identity is baked into the
// Session once, then projects.get(id) scopes to a project the directory says you may reach.
//
// Mirrors apps/os / the kernel's Os→Session→ProjectCollection→Project tree, but backed by the D1 directory
// instead of the provider switch. Execution capabilities (serve/runScript) dial the project worker —
// Phase 6 C; for now the tree covers identity + the directory (list/get/create), the /api half of the merge.

import { RpcTarget } from "cloudflare:workers";
import { directory, type Grant } from "./directory.ts";
import type { Env } from "./env.ts";
import { sha256hex } from "./hash.ts";
import { currentSession } from "./session.ts";

/** The resolved caller behind an /api session. `grants: "all"` = a human (full membership). */
interface Caller {
  actor: string;
  email: string;
  grants: Grant[] | "all";
}

/** A project handle. Execution capabilities attach here in Phase 6 C (dial the runner). */
class Project extends RpcTarget {
  constructor(
    private readonly id: string,
    private readonly slug: string,
  ) {
    super();
  }
  get projectId(): string {
    return this.id;
  }
  get projectSlug(): string {
    return this.slug;
  }
}

/** projects.get() is the membership gate; create() emerges an org+project; list() is your reachable set. */
class ProjectCollection extends RpcTarget {
  constructor(
    private readonly caller: Caller,
    private readonly env: Env,
  ) {
    super();
  }
  async list(): Promise<string[]> {
    const ps = await directory(this.env.DB).listProjects(this.caller.actor);
    return ps.map((p) => p.slug);
  }
  async get(slug: string): Promise<Project> {
    const dir = directory(this.env.DB);
    const project = await dir.getBySlug(slug);
    if (!project)
      throw new Error(`project '${slug}' does not exist — create it with projects.create(...)`);
    const access = await dir.access(this.caller.actor, project.id);
    if (!access.ok) throw new Error(`not a member of project '${slug}'`);
    return new Project(project.id, project.slug);
  }
  async create(slug: string, orgName?: string): Promise<Project> {
    const { project } = await directory(this.env.DB).emerge(
      this.caller.actor,
      orgName || `${this.caller.email}'s org`,
      slug,
    );
    return new Project(project.id, project.slug);
  }
}

/** What authenticate() hands back — identity baked in once (session-scoped). */
class Session extends RpcTarget {
  constructor(
    private readonly caller: Caller,
    private readonly env: Env,
  ) {
    super();
  }
  whoami(): { actor: string; email: string } {
    return { actor: this.caller.actor, email: this.caller.email };
  }
  get projects(): ProjectCollection {
    return new ProjectCollection(this.caller, this.env);
  }
}

/** The unauthenticated `/api` root. authenticate() resolves session cookie → API-key bearer → anonymous. */
export class Os extends RpcTarget {
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {
    super();
  }
  async authenticate(): Promise<Session> {
    const session = await currentSession(this.request, this.env.SESSION_SECRET);
    if (session)
      return new Session({ actor: session.sub, email: session.email, grants: "all" }, this.env);

    const auth = this.request.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (bearer) {
      const resolved = await directory(this.env.DB).resolveApiKey(await sha256hex(bearer));
      if (resolved)
        return new Session(
          { actor: resolved.userId, email: "(api-key)", grants: resolved.grants },
          this.env,
        );
    }
    // Anonymous — first-class (wide-open). projects.list() returns [] for user_anonymous.
    return new Session({ actor: "user_anonymous", email: "anonymous", grants: [] }, this.env);
  }
}
