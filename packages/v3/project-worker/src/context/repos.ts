// repos.ts — THE PROJECT'S REPOS: the Artifacts binding, one file at a time. Two roots, one prefix:
//   • `itx.cfArtifacts` (`projectScopedArtifacts`) — the RAW Cloudflare Artifacts binding, project-
//     scoped and shaped like the real binding: the control-plane escape hatch (create / get / list /
//     delete a repo; a repo's bytes are git-over-HTTPS, below);
//   • `itx.repos` (`projectScopedRepos`) — the MINIMAL git-backed layer built ON TOP of it +
//     `./git-wire` (the copied git-over-HTTPS engine): just enough to move the config worker's
//     source out of KV and into a real repo —
//       readFile(repo, path)  — the tip commit's tree → the path's blob (the `itx.worker` source producer);
//       writeFile(repo, path, content) — one commit on `main` (create the repo on first write; seeding).
//
// SCOPE of `itx.repos`, deliberately tiny: root-level paths only (no nested trees), branch `main`, no
// history walk (a shallow `deepen: 1` fetch is the whole snapshot), no merge conflict handling (writes
// to the config repo are single-writer). Both roots address the very same repos under the ONE
// `${projectId}.` name prefix (`ArtifactsScope` says why `.`); the remote is built from the account +
// namespace vars, and Artifacts hands the same URL back from `create`, so the two always agree.

import { RpcTarget } from "capnweb";
import {
  buildPack,
  createGitWireTransport,
  encodeCommit,
  encodeTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObjectType,
  type RawGitObject,
  type TreeEntry,
} from "./git-wire.ts";

// ── `itx.cfArtifacts` — the raw binding, project-scoped ──

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
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken>;
  fork(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
}
/** `createToken`'s result — `plaintext` is the git credential string. */
interface ArtifactToken {
  plaintext: string;
  expiresAt?: string;
}
/** `list`'s result: repos in the WHOLE namespace (the binding does NOT filter by name), one page. */
interface ArtifactListResult {
  repos: { name: string }[];
  cursor?: string;
}
/** What `itx.cfArtifacts.get` returns: a genuine capnweb `RpcTarget`, so a client can pipeline
 *  `get(name).createToken(...)` ACROSS the /api hop exactly like the real binding's handle — a plain
 *  object cannot (its `createToken` closure is NonPipelinable and fails to serialize; invoke-handle.ts). */
export class ScopedArtifactRepo extends RpcTarget {
  readonly #handle: ArtifactRepoHandle;
  constructor(handle: ArtifactRepoHandle) {
    super();
    this.#handle = handle;
  }
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken> {
    return this.#handle.createToken(scope, ttlSeconds);
  }
}

/** `itx.cfArtifacts` — the RAW Artifacts binding, project-scoped, and shaped like the real binding:
 *  its methods return the SAME SHAPES (`create` a repo → its initial git token; `get` a repo's handle;
 *  `list` this project's repos; `delete` one — project teardown deletes a project's repos). THE
 *  ISOLATION WALL, enforced here and not by the binding: every repo name is forced under this
 *  project's `${projectId}.` prefix (like `itx.kv`'s `${projectId}:`). The delimiter is `.` ON
 *  PURPOSE: project IDs are `[A-Za-z0-9_-]` (no `.`), so `${projectId}.` cannot collide even when IDs
 *  contain `-` (a `--` delimiter could: `a` + `b--x` == `a--b` + `x`), and repo names allow `.`. `list`
 *  is filtered to the prefix LOCALLY (the binding returns EVERY project's repos), and `get` returns a
 *  `ScopedArtifactRepo` exposing only `createToken`: the real handle's `fork(name)` takes an
 *  UNPREFIXED name — walked by the dispatcher regardless of the narrowed type — and would escape the
 *  wall, so it is withheld. */
export interface ArtifactsScope {
  create(name: string, options?: { setDefaultBranch?: string }): Promise<ArtifactCreateResult>;
  get(name: string): Promise<ScopedArtifactRepo>;
  list(options?: { limit?: number; cursor?: string }): Promise<ArtifactListResult>;
  delete(name: string): Promise<boolean>;
}

/** Pure and namespace-injected: unit-tests alone (built-ins-artifacts.test.ts). */
export function projectScopedArtifacts(
  namespace: ArtifactsNamespace,
  projectId: string,
): ArtifactsScope {
  const prefix = `${projectId}.`;
  return {
    create: (name, options) => namespace.create(prefix + name, options),
    get: async (name) => new ScopedArtifactRepo(await namespace.get(prefix + name)),
    list: async (options) => {
      const page = await namespace.list(options);
      return {
        repos: page.repos.flatMap((r) =>
          r.name.startsWith(prefix) ? [{ name: r.name.slice(prefix.length) }] : [],
        ),
        ...(page.cursor !== undefined && { cursor: page.cursor }),
      };
    },
    delete: (name) => namespace.delete(prefix + name),
  };
}

// ── `itx.repos` — one file at a time, over git-wire ──

const BRANCH = "main";
const REF = `refs/heads/${BRANCH}`;
const ZERO_OID = "0".repeat(40);
const TOKEN_TTL_SECONDS = 300;
const AUTHOR = { email: "config@iterate.com", name: "iterate" };
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** The Artifacts "repo does not exist" signal (API error 10200, "Repository not found") — the ONLY
 *  read failure that legitimately means "no file". An outage or auth error must SURFACE, never
 *  masquerade as an absent file (that would silently blank the config worker's source). */
const isRepoNotFound = (error: unknown): boolean =>
  /not found|10200/i.test(String((error as { message?: unknown })?.message ?? error));

/** `itx.repos` — a project's git repos, one file at a time. Data in, data out (no handles cross /api). */
export interface ReposScope {
  /** The bytes of `path` at the tip of `main`, or null if the repo is unborn / the file is absent. */
  readFile(repo: string, path: string): Promise<string | null>;
  /** Commit `content` to `path` on `main` (creating the repo on first write); returns the new commit. */
  writeFile(repo: string, path: string, content: string): Promise<{ commitOid: string }>;
}

export function projectScopedRepos(input: {
  namespace: ArtifactsNamespace;
  projectId: string;
  accountId: string;
  namespaceName: string;
}): ReposScope {
  const prefix = `${input.projectId}.`;

  const rootName = (path: string): string => {
    if (path.includes("/"))
      throw new Error(`itx.repos: nested paths are not supported yet ("${path}")`);
    return path;
  };

  /** A read/write transport for one repo: a token minted on the existing repo, or — a write on a
   *  repo that does not exist yet — the initial write token of a `create` (Artifacts defaults the
   *  branch to `main`, our REF). Anything else (an outage, an auth failure) surfaces as what it is. */
  const transportFor = async (repo: string, scope: "read" | "write") => {
    let token: string;
    try {
      ({ plaintext: token } = await (
        await input.namespace.get(prefix + repo)
      ).createToken(scope, TOKEN_TTL_SECONDS));
    } catch (error) {
      if (scope !== "write" || !isRepoNotFound(error)) throw error;
      ({ token } = await input.namespace.create(prefix + repo));
    }
    return createGitWireTransport({
      remote: `https://${input.accountId}.artifacts.cloudflare.net/git/${input.namespaceName}/${prefix}${repo}.git`,
      token,
    });
  };

  /** The tip's SNAPSHOT — one shallow fetch: the tip commit's tree entries, and every object the pack
   *  carried by oid (the endpoint sends every blob reachable from the tip, so a file's bytes are
   *  already here — `readFile` never fetches twice). A pack that omits the commit or its tree is an
   *  OUTAGE, not an empty tree — git drops wants for missing oids silently, so receipt is verified
   *  here. */
  const tipSnapshot = async (
    transport: Awaited<ReturnType<typeof transportFor>>,
    tip: string,
  ): Promise<{ entries: TreeEntry[]; objects: Map<string, RawGitObject> }> => {
    const objects = new Map<string, RawGitObject>(
      (await transport.fetchObjects({ wants: [tip], deepen: 1 })).map((o) => [o.oid, o]),
    );
    const commit = objects.get(tip);
    if (commit?.type !== "commit")
      throw new Error(`itx.repos: the pack omitted the tip commit ${tip} of ${REF}`);
    const tree = objects.get(parseCommit(commit.payload).tree);
    if (tree?.type !== "tree")
      throw new Error(`itx.repos: the pack omitted the tree of the tip commit ${tip}`);
    return { entries: parseTree(tree.payload), objects };
  };

  return {
    readFile: async (repo, path) => {
      const name = rootName(path);
      let transport: Awaited<ReturnType<typeof transportFor>>;
      try {
        transport = await transportFor(repo, "read");
      } catch (error) {
        if (isRepoNotFound(error)) return null; // no such repo → no file
        throw error; // an outage / auth failure must surface, not read as an absent file
      }
      const tip = await transport.tipOf(REF);
      if (tip === undefined) return null; // unborn repo (no commit on main)
      const { entries, objects } = await tipSnapshot(transport, tip);
      const entry = entries.find((e) => e.name === name);
      if (!entry) return null; // absent: the tip's tree does not name it
      const blob = objects.get(entry.oid);
      if (blob?.type !== "blob")
        throw new Error(
          `itx.repos: the pack for ${repo} omitted the blob of ${name} (${entry.oid})`,
        );
      return textDecoder.decode(blob.payload);
    },

    writeFile: async (repo, path, content) => {
      const name = rootName(path);
      const transport = await transportFor(repo, "write");
      const blob = textEncoder.encode(content);
      const blobOid = await hashObject("blob", blob);

      // Merge onto the tip's tree if the repo already has a commit; otherwise this is the first commit.
      // (A tip whose commit or tree the pack omits THROWS in tipSnapshot — never a fresh root commit
      // that would repoint `main` at an orphan.)
      const tip = await transport.tipOf(REF);
      const entries: TreeEntry[] =
        tip === undefined
          ? []
          : (await tipSnapshot(transport, tip)).entries.filter((e) => e.name !== name);
      const parents = tip === undefined ? [] : [tip];
      entries.push({ mode: "100644", name, oid: blobOid });

      const treeBytes = encodeTree(entries);
      const treeOid = await hashObject("tree", treeBytes);
      const commitBytes = encodeCommit({
        author: { ...AUTHOR, date: new Date() },
        message: `itx.repos: write ${name}`,
        parents,
        tree: treeOid,
      });
      const commitOid = await hashObject("commit", commitBytes);

      const objects: { payload: Uint8Array; type: GitObjectType }[] = [
        { payload: commitBytes, type: "commit" },
        { payload: treeBytes, type: "tree" },
        { payload: blob, type: "blob" },
      ];
      const refused = await transport.push({
        newOid: commitOid,
        oldOid: tip ?? ZERO_OID,
        pack: await buildPack(objects),
        ref: REF,
      });
      if (refused !== null) throw new Error(`itx.repos: push of ${name} was refused: ${refused}`);
      return { commitOid };
    },
  };
}
