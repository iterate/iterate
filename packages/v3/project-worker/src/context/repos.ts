// repos.ts — `itx.repos`: the MINIMAL git-backed repo layer, one file at a time, built ON TOP of the
// Artifacts binding (`itx.cfArtifacts`) + `./git-wire` (the copied git-over-HTTPS engine).
// Just enough to move the config worker's source out of KV and into a real repo:
//   • readFile(repo, path)  — the tip commit's tree → the path's blob (the `itx.worker` source producer).
//   • writeFile(repo, path, content) — one commit on `main` (create the repo on first write; seeding).
//
// SCOPE, deliberately tiny: root-level paths only (no nested trees), branch `main`, no history walk
// (a shallow `deepen: 1` fetch is the whole snapshot), no merge conflict handling (writes to the config
// repo are single-writer). Project isolation is the SAME `${projectId}.` repo-name prefix cfArtifacts
// uses (built-ins.ts) — repos and cfArtifacts address the very same repos. The remote is built from the
// account + namespace vars; Artifacts hands the same URL back from `create`, so the two always agree.

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
import type { ArtifactsNamespace } from "./built-ins.ts";

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

  /** A read/write transport for one repo. Read mints via `get`; write creates the repo (fresh → initial
   *  write token) or, if it already exists, mints a write token. */
  const transportFor = async (repo: string, scope: "read" | "write") => {
    let token: string;
    try {
      ({ plaintext: token } = await (
        await input.namespace.get(prefix + repo)
      ).createToken(scope, TOKEN_TTL_SECONDS));
    } catch (error) {
      // A repo that does not exist yet is CREATED on first write — its initial token is a write
      // token, and Artifacts defaults the branch to `main` (our REF). Anything else (an outage, an
      // auth failure) surfaces as what it is.
      if (scope !== "write" || !isRepoNotFound(error)) throw error;
      ({ token } = await input.namespace.create(prefix + repo));
    }
    return createGitWireTransport({
      remote: `https://${input.accountId}.artifacts.cloudflare.net/git/${input.namespaceName}/${prefix}${repo}.git`,
      token,
    });
  };

  const tipOid = (refs: { name: string; oid: string }[]): string | undefined =>
    refs.find((r) => r.name === REF)?.oid;

  /** The tip commit's tree entries. A pack that omits the commit or its tree is an OUTAGE, not an
   *  empty tree — git drops wants for missing oids silently, so the caller verifies receipt here. */
  const tipTreeEntries = async (
    transport: Awaited<ReturnType<typeof transportFor>>,
    tip: string,
  ): Promise<TreeEntry[]> => {
    const objects = await transport.fetchObjects({ wants: [tip], deepen: 1 });
    const byOid = new Map<string, RawGitObject>(objects.map((o) => [o.oid, o]));
    const commit = byOid.get(tip);
    if (commit?.type !== "commit")
      throw new Error(`itx.repos: the pack omitted the tip commit ${tip} of ${REF}`);
    const tree = byOid.get(parseCommit(commit.payload).tree);
    if (tree?.type !== "tree")
      throw new Error(`itx.repos: the pack omitted the tree of the tip commit ${tip}`);
    return parseTree(tree.payload);
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
      const tip = tipOid(await transport.lsRefs([REF]));
      if (tip === undefined) return null; // unborn repo (no commit on main)
      const entries = await tipTreeEntries(transport, tip);
      const entry = entries.find((e) => e.name === name);
      if (!entry) return null; // absent: the tip's tree does not name it
      const blob = (await transport.fetchObjects({ wants: [entry.oid], deepen: 1 })).find(
        (o) => o.oid === entry.oid,
      );
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
      // (A tip whose commit or tree the pack omits THROWS in tipTreeEntries — never a fresh root
      // commit that would repoint `main` at an orphan.)
      const tip = tipOid(await transport.lsRefs([REF]));
      const entries: TreeEntry[] =
        tip === undefined
          ? []
          : (await tipTreeEntries(transport, tip)).filter((e) => e.name !== name);
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
      const report = await transport.push({
        newOid: commitOid,
        oldOid: tip ?? ZERO_OID,
        pack: await buildPack(objects),
        ref: REF,
      });
      if (report.kind !== "applied") {
        throw new Error(`itx.repos: push of ${name} was ${report.kind}: ${report.detail ?? ""}`);
      }
      return { commitOid };
    },
  };
}
