// next/api.ts — THE API AN APP DIALS: the shapes of os-next's `/api` root, the session it vends and a
// context's door, as a capnweb client sees them. DECLARED here, never generated, and never the
// platform's classes: os-next asserts that `IterateRpcTarget` satisfies `IterateApi` (src/session.ts),
// so an app built against this package types against exactly what the deployment answers. A
// context is ONE door — `invoke(call, ...args)`, a dotted itx expression — and a capnweb stub proxies
// the dotted spelling (`itx.repos.get(path).readFile(file)`) onto it, so nothing else is declared.
import type { ItxExpressionInput } from "./expression.ts";
import type { Principal } from "./principal.ts";

/** What `authenticate` accepts: the browser (its login cookie rode the upgrade), a device or script
 *  (its bearer token did), or the operator (the deployment's admin secret, verified in-band). */
export type SessionCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer" }
  | { type: "admin-secret"; secret: string; as?: { email: string } };

/** A context (a project, a user, an organization) — every `itx` root behind one door. */
export interface IterateContextApi {
  invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
  [Symbol.dispose](): void;
}

/** A project as the catalog lists it. */
export interface ProjectRecord {
  id: string;
  orgId: string;
}

/** The session `authenticate` vends: who is calling, and the contexts they reach. */
export interface IterateSessionApi {
  whoami(): Principal;
  projects: {
    list(): Promise<ProjectRecord[]>;
    get(project: string): Promise<IterateContextApi>;
    create(input: { project: string; orgId?: string }): Promise<IterateContextApi>;
  };
  organizations: { get(orgId: string): Promise<IterateContextApi> };
  user: IterateContextApi;
  logout(): unknown;
  [Symbol.dispose](): void;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. */
export interface IterateApi {
  authenticate(credentials: SessionCredentials): Promise<IterateSessionApi>;
}
