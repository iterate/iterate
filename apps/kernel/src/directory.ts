import { decodeJwt } from "jose";

// ---------------------------------------------------------------------------
// The DIRECTORY authority — "which projects exist + who's a member, and how new ones are born" —
// as a pluggable knob, SEPARATE from the identity authority (who-are-you). Design discussion:
//   ../os/docs/simplification/kernel-review-2026-07-28.md  (§ directory vs identity)
//
// Dependency direction is a clean DAG: the kernel READS/WRITES the directory it's configured with;
// the directory NEVER calls the kernel. Hosted binds the REAL auth worker (`auth-prd`) over a
// same-account Service binding (`env.AUTH`) — reads (getProjectBySlug/listProjectsForUser) AND the
// create write (createProjectForOrganization) both go to auth, which owns the directory. Self-host
// uses a local KV registry (`env.DIRECTORY_KV`) — create/read entirely local, no auth at all.
// ---------------------------------------------------------------------------

type Caller = { credentials: ({ format: string; issuer: string } & Record<string, unknown>)[] };

// The slice of the auth worker's directory RPC the kernel uses (apps/auth-contract's AuthWorker).
// Reads + the one create write; `userId`/`organizationSlug` come from the caller's token claims.
export type AuthDirectory = {
  getProjectBySlug(input: {
    projectSlug: string;
  }): Promise<{ id: string; slug: string; organizationId: string } | null>;
  listProjectsForUser(input: {
    userId: string;
  }): Promise<{ id: string; slug: string; organizationId: string }[]>;
  // Membership by the auth USER ID, when the wall JWT carries it (Cloudflare Access maps auth's `sub`
  // into `custom.sub`). The canonical stable key — preferred over email when present.
  getUserGrants(input: { userId: string }): Promise<{
    projects: { id: string; slug: string; organizationId: string }[];
  }>;
  // Membership by the caller's verified EMAIL — the fallback when the userId claim isn't on the JWT
  // (a wall always carries the verified email; Access's `custom.sub` is best-effort). Same bundle.
  getUserGrantsByEmail(input: { email: string }): Promise<{
    projects: { id: string; slug: string; organizationId: string }[];
  }>;
  createProjectForOrganization(input: {
    organizationSlug: string;
    name: string;
    slug?: string;
  }): Promise<
    | { ok: true; project: { id: string; slug: string } }
    | { ok: false; reason: string; message: string }
  >;
};

// The slice of a Cloudflare KV namespace the local directory needs (structural — so this module
// stays free of the ambient `KVNamespace` type and unit-tests with a Map-backed mock).
export type KVLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
};

export type DirectoryConfig =
  | { provider: "open" } // no directory: every project reachable by anyone; create is trivial
  | { provider: "local"; projects: string[] } // a fixed, read-only set (create is refused)
  | { provider: "kv" } // a local persistent registry (self-host, creatable) — needs DIRECTORY_KV
  | { provider: "auth.iterate.com" }; // the real auth-prd directory over the AUTH service binding

// `exists` on denial lets projects.get() return a PROSPECTIVE handle for an unknown slug (whose
// create() births it) vs throwing for a real project you're not a member of — exactly apps/os.
export type Access = { ok: true } | { ok: false; exists: boolean; reason: string };
export type CreateResult =
  | { ok: true; project: { id: string; slug: string } }
  | { ok: false; reason: string };

// create() args mirror apps/os `get(slug).create({ organizationSlug?, projectId? })`: the slug comes
// from the get() handle; the org (hosted) and a caller-managed id are optional. No `name`.
export type Directory = {
  access(caller: Caller, projectId: string): Access | Promise<Access>;
  list(caller: Caller): string[] | Promise<string[]>;
  create(
    caller: Caller,
    input: { slug: string; organizationSlug?: string; projectId?: string },
  ): Promise<CreateResult>;
};

export function directoryFor(
  cfg: { directory?: DirectoryConfig },
  env: { AUTH?: AuthDirectory; DIRECTORY_KV?: KVLike },
): Directory {
  const dir = cfg.directory ?? { provider: "open" };
  switch (dir.provider) {
    case "open":
      return {
        access: () => ({ ok: true }),
        list: () => [],
        // Nothing to persist: an open project exists the moment you name it.
        create: async (_caller, input) => ({ ok: true, project: slugId(input.slug) }),
      };
    case "local": {
      const set = new Set(dir.projects);
      return {
        access: (_caller, id) =>
          set.has(id)
            ? { ok: true }
            : { ok: false, exists: false, reason: `no such project '${id}'` },
        list: () => [...set],
        create: async () => ({ ok: false, reason: "read-only directory (fixed project set)" }),
      };
    }
    case "kv": {
      const kv = env.DIRECTORY_KV;
      const key = (slug: string) => `project:${slug}`;
      return {
        async access(_caller, id) {
          if (!kv)
            return {
              ok: false,
              exists: false,
              reason: "directory unavailable (no DIRECTORY_KV binding)",
            };
          return (await kv.get(key(id)))
            ? { ok: true }
            : { ok: false, exists: false, reason: `no such project '${id}'` };
        },
        async list() {
          if (!kv) return [];
          return (await kv.list({ prefix: "project:" })).keys.map((k) =>
            k.name.slice("project:".length),
          );
        },
        async create(caller, input) {
          if (!kv) return { ok: false, reason: "directory unavailable (no DIRECTORY_KV binding)" };
          const { id, slug } = slugId(input.slug);
          // Idempotent: creating an existing slug just returns it.
          if (!(await kv.get(key(slug))))
            await kv.put(
              key(slug),
              // createdBy is a display-only label: the wall JWT's `sub` (Cloudflare's id behind
              // Access, auth's behind a direct token), or anonymous. Not an authorization key.
              JSON.stringify({ createdBy: claim(caller, "sub") ?? "anonymous" }),
            );
          return { ok: true, project: { id, slug } };
        },
      };
    }
    case "auth.iterate.com": {
      const auth = env.AUTH;
      return {
        async access(caller, id) {
          if (!auth)
            return { ok: false, exists: false, reason: "directory unavailable (no AUTH binding)" };
          // Resolve existence first (project slugs are public — this is what proves the live binding),
          // then membership. Exactly apps/os: resolve the id, then authorize against it.
          const project = await auth.getProjectBySlug({ projectSlug: id });
          if (!project) return { ok: false, exists: false, reason: `no such project '${id}'` };
          const projects = await grantsFor(auth, caller);
          return projects.some((p) => p.id === project.id)
            ? { ok: true }
            : { ok: false, exists: true, reason: `not a member of project '${id}'` };
        },
        async list(caller) {
          if (!auth) return [];
          return (await grantsFor(auth, caller)).map((p) => p.slug);
        },
        async create(_caller, input) {
          // Auth OWNS the write: it inserts the row in its directory and stays the source of truth, so
          // the kernel never reaches below itself. The owning org is an EXPLICIT organizationSlug — the
          // security-relevant input. (We used to auto-resolve it from the caller's access token, but
          // carrying that raw token wasn't worth the cost; a proper "your orgs" lookup can come later.)
          if (!auth) return { ok: false, reason: "directory unavailable (no AUTH binding)" };
          if (input.organizationSlug === undefined)
            return {
              ok: false,
              reason: "pass organizationSlug (which organization owns the project)",
            };
          // apps/os passes name = slug (the slug IS the display name at birth).
          const result = await auth.createProjectForOrganization({
            organizationSlug: input.organizationSlug,
            name: input.slug,
            slug: input.slug,
          });
          return result.ok
            ? { ok: true, project: result.project }
            : { ok: false, reason: result.message };
        },
      };
    }
  }
}

// A normalized slug + id for stores that don't mint their own (open/kv): the id IS the slug.
function slugId(rawSlug: string): { id: string; slug: string } {
  const slug = rawSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { id: slug, slug };
}

// The caller's project grants from auth, resolved by the STABLEST key the wall JWT carries: the auth
// user id (Cloudflare Access maps auth's `sub` into `custom.sub`) when present, else the verified email
// (always present on a wall JWT). userId is canonical; email is the robust fallback. Empty for anon.
async function grantsFor(
  auth: AuthDirectory,
  caller: Caller,
): Promise<{ id: string; slug: string; organizationId: string }[]> {
  const custom = claim(caller, "custom");
  const userId =
    custom && typeof custom === "object" ? (custom as Record<string, unknown>).sub : undefined;
  if (typeof userId === "string") return (await auth.getUserGrants({ userId })).projects;
  const email = claim(caller, "email");
  if (typeof email === "string") return (await auth.getUserGrantsByEmail({ email })).projects;
  return [];
}

// Decode a claim from the caller's verified wall JWT (`email`, `custom.sub`). Any issuer: the wall
// already verified the signature; we only decode. There's one wall JWT per caller (format "jwt").
function claim(caller: Caller, name: string): unknown {
  const jwt = caller.credentials.find((c) => c.format === "jwt")?.jwt;
  return typeof jwt === "string" ? decodeJwt(jwt)[name] : undefined;
}
