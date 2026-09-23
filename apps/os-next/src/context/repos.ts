// repos.ts — `itx.cfArtifacts`: Cloudflare Artifacts, project-scoped, addressed BY THE REPO'S PATH — a
// PROXY to the binding and nothing more: `create` / `get` / `list` / `delete` a repo, and the two facts
// git-over-HTTPS needs from it, a token (`get(path).createToken`) and the remote URL (`get(path).remote()`,
// the binding's own — it knows the account and namespace; nothing here spells them).
// GIT ITSELF — files, commits, the wire — lives in the repo facet (src/repo/durable-object.ts over
// src/repo/git-wire.ts), the domain object `itx.repos.get(path)`: THAT is how a project interacts with
// its repos, and the only thing that speaks git. This root is what the facet calls for its credential
// and remote, and where a test lends a fake (`provide("itx.cfArtifacts", …)`, e2e/support/fake-artifacts.ts).
//
// THE ISOLATION WALL is here, not in the binding: every repo is `${projectId}.` + the path's Artifacts
// name (`repoArtifactName` — the ONE place a name is spelled; every itx surface speaks paths).

import { RpcTarget } from "capnweb";

/** Cloudflare Artifacts ("git for agents", beta) — the per-namespace binding, CONTROL PLANE ONLY, and
 *  typed minimally here (not in `@cloudflare/workers-types` yet; reconcile against `wrangler types`
 *  when the namespace is provisioned). `create` returns the repo's initial git credential; `get`
 *  returns a repo HANDLE (mint a credential with `createToken`); `list` is UNFILTERED. */
export interface ArtifactsNamespace {
  create(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
  get(name: string): Promise<ArtifactRepoHandle>;
  list(options?: { limit?: number; cursor?: string }): Promise<ArtifactListResult>;
  delete(name: string): Promise<boolean>;
}
/** `create`/`import`'s result: the repo's initial git credential (typed minimally — there may be more). */
interface ArtifactCreateResult {
  token: string;
}
/** The REAL repo handle `get()` yields (a live RPC stub), typed to what is read (`ArtifactsScope` says
 *  why `fork` is withheld). */
export interface ArtifactRepoHandle {
  /** the repo's metadata — its git-over-HTTPS `remote`, the binding's own word (account and namespace
   *  included). A METHOD: the handle is a Workers-RPC stub, whose data fields do not cross the wire. */
  info(): Promise<{ remote: string }>;
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken>;
  fork(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
}
/** `createToken`'s result — `plaintext` is the git credential string. */
export interface ArtifactToken {
  plaintext: string;
  expiresAt?: string;
}
/** `list`'s result: repos in the WHOLE namespace (the binding does NOT filter by name), one page. */
interface ArtifactListResult {
  repos: { name: string }[];
  cursor?: string;
}

/** What `itx.cfArtifacts.get(path)` returns: a genuine capnweb `RpcTarget`, so a client can pipeline
 *  `get(path).createToken(...)` ACROSS the /api hop exactly like the real binding's handle — a plain
 *  object cannot (its `createToken` closure is NonPipelinable and fails to serialize; expression.ts's
 *  `InvokeHandle`). It adds `remote()`, the git-over-HTTPS URL of this repo — the platform knows the
 *  account and namespace; the repo facet does not. It holds the repo's NAME, never the binding's
 *  handle: a handle is a live Workers-RPC stub, and one kept here held this actor's session to
 *  Artifacts — and the actor — open until the next deploy (2026-09-23). Each verb takes a handle and
 *  releases it (`withArtifactRepoHandle`). */
export class ScopedArtifactRepoRpcTarget extends RpcTarget {
  readonly #namespace: ArtifactsNamespace;
  readonly #name: string;
  readonly #remote: string;
  constructor(namespace: ArtifactsNamespace, name: string, remote: string) {
    super();
    this.#namespace = namespace;
    this.#name = name;
    this.#remote = remote;
  }
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken> {
    return withArtifactRepoHandle(this.#namespace, this.#name, (handle) =>
      handle.createToken(scope, ttlSeconds),
    );
  }
  /** `https://<account>.artifacts.cloudflare.net/git/<namespace>/<project>.<name>.git` (the binding's
   *  own word) — what a git client POSTs `git-upload-pack` / `git-receive-pack` under, the token as
   *  the basic-auth password. */
  remote(): string {
    return this.#remote;
  }
}

/** One binding handle for one verb, released after, its answer copied out: the handle and the answer
 *  object (facet-host.ts `#call` says why) each keep this actor's session to Artifacts open until
 *  disposed. */
async function withArtifactRepoHandle<T>(
  namespace: ArtifactsNamespace,
  name: string,
  verb: (handle: ArtifactRepoHandle) => Promise<T>,
): Promise<T> {
  const handle = await namespace.get(name);
  try {
    const answer = await verb(handle);
    const copy = structuredClone(answer);
    // The real answer and handle are disposable (Workers-RPC); a test's fake may not be.
    (answer as Partial<Disposable>)[Symbol.dispose]?.();
    return copy;
  } finally {
    (handle as Partial<Disposable>)[Symbol.dispose]?.();
  }
}

/** The Artifacts repo a PATH is backed by: the path's segments joined with `--` (`/repos/config` →
 *  `repos--config`, `/vendor/lib` → `vendor--lib`), which Artifacts' name grammar
 *  (`[a-zA-Z0-9][a-zA-Z0-9._-]*`) accepts. Injective because a segment may not contain `--`
 *  (refused, as is a segment outside the grammar and the root itself); `repoPathOf` is its inverse.
 *  THE ONE PLACE a name is spelled — every itx surface speaks paths. */
export function repoArtifactName(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0)
    throw new Error("itx.cfArtifacts: the project's root context is not a repo");
  for (const segment of segments)
    if (segment.includes("--") || !/^[a-zA-Z0-9._-]+$/.test(segment))
      throw new Error(
        `itx.cfArtifacts: "${path}" cannot back an Artifacts repo — a path segment is [a-zA-Z0-9._-]+ without "--" (got "${segment}")`,
      );
  const name = segments.join("--");
  if (!/^[a-zA-Z0-9]/.test(name))
    throw new Error(
      `itx.cfArtifacts: "${path}" cannot back an Artifacts repo — its name must start with a letter or digit`,
    );
  return name;
}

/** The path an Artifacts repo NAME (unprefixed) backs — `repoArtifactName`'s inverse. */
export function repoPathOf(name: string): string {
  return `/${name.split("--").join("/")}`;
}

/** The Artifacts "repo does not exist" signal (API error 10200, "Repository not found") — the ONLY
 *  failure `create` reads as "not yet"; an outage or an auth error surfaces as what it is. */
const isRepoNotFound = (error: unknown): boolean =>
  /not found|10200/i.test(String((error as { message?: unknown })?.message ?? error));

/** The TTL of the probe token `create` mints to learn whether a repo exists. */
const PROBE_TOKEN_TTL_SECONDS = 60;

/** `itx.cfArtifacts` — Cloudflare Artifacts, project-scoped, BY PATH: the binding proxy beneath
 *  `itx.repos.get(path)`. THE ISOLATION WALL, enforced here and not by the binding: every repo name
 *  is forced under this project's `${projectId}.` prefix (like `itx.kv`'s `${projectId}:`). The
 *  delimiter is `.` ON PURPOSE: project IDs are `[A-Za-z0-9_-]` (no `.`), so `${projectId}.` cannot
 *  collide even when IDs contain `-` (a `--` delimiter could: `a` + `b--x` == `a--b` + `x`), and repo
 *  names allow `.`. `list` is filtered to the prefix LOCALLY (the binding returns EVERY project's
 *  repos) and answers in paths, and `get` returns a `ScopedArtifactRepoRpcTarget` exposing `createToken` and
 *  `remote` only: the real handle's `fork(name)` takes an UNPREFIXED name — walked by the dispatcher
 *  regardless of the narrowed type — and would escape the wall, so it is withheld. */
export interface ArtifactsScope {
  /** The Artifacts repo, `main` unborn until the first commit; false when it already existed. */
  create(path: string): Promise<{ created: boolean }>;
  /** The repo's handle — `createToken(scope, ttlSeconds)` and `remote()`. */
  get(path: string): Promise<ScopedArtifactRepoRpcTarget>;
  /** This project's repos, as paths (one page of the binding's unfiltered list). */
  list(options?: { limit?: number; cursor?: string }): Promise<{
    repos: { path: string }[];
    cursor?: string;
  }>;
  delete(path: string): Promise<boolean>;
}

/** Pure and namespace-injected: unit-tests alone (repos.test.ts). Every `path` is a repo's context
 *  path (`/repos/config`); `boundName` is the one step from it to the bound Artifacts name. */
export function projectScopedArtifacts(input: {
  namespace: ArtifactsNamespace;
  projectId: string;
}): ArtifactsScope {
  const prefix = `${input.projectId}.`;
  const boundName = (path: string): string => prefix + repoArtifactName(path);
  return {
    create: async (path) => {
      const name = boundName(path);
      // The probe is what a read does — a handle AND a token, since either may be where the binding
      // says "not found"; anything else (an outage, an auth failure) surfaces as what it is.
      try {
        await withArtifactRepoHandle(input.namespace, name, (handle) =>
          handle.createToken("read", PROBE_TOKEN_TTL_SECONDS),
        );
        return { created: false };
      } catch (error) {
        if (!isRepoNotFound(error)) throw error;
      }
      // The result carries the repo's initial credential, unread — and, a Workers-RPC result, a disposer.
      const created = await input.namespace.create(name);
      (created as Partial<Disposable>)[Symbol.dispose]?.();
      return { created: true };
    },
    get: async (path) => {
      const name = boundName(path);
      const { remote } = await withArtifactRepoHandle(input.namespace, name, (handle) =>
        handle.info(),
      );
      return new ScopedArtifactRepoRpcTarget(input.namespace, name, remote);
    },
    list: async (options) => {
      const page = await input.namespace.list(options);
      return {
        repos: page.repos.flatMap((r) =>
          r.name.startsWith(prefix) ? [{ path: repoPathOf(r.name.slice(prefix.length)) }] : [],
        ),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- a wire view: an absent cursor stays ABSENT (capnweb serializes an undefined-valued key as present)
        ...(page.cursor !== undefined && { cursor: page.cursor }),
      };
    },
    delete: (path) => input.namespace.delete(boundName(path)),
  };
}
