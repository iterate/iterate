// repos.ts — `itx.repos`: the MINIMAL git-backed repo layer, one file at a time, built ON TOP of the
// Artifacts binding (`itx.cfArtifacts`) + `../shared/git-wire` (the copied git-over-HTTPS engine).
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
} from "../shared/git-wire.ts";
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
  fetchImpl?: typeof fetch;
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
    if (scope === "write") {
      try {
        // Fresh repo → its initial write token. Artifacts defaults the branch to `main` (our REF).
        ({ token } = await input.namespace.create(prefix + repo));
      } catch {
        ({ plaintext: token } = await (
          await input.namespace.get(prefix + repo)
        ).createToken("write", TOKEN_TTL_SECONDS));
      }
    } else {
      ({ plaintext: token } = await (
        await input.namespace.get(prefix + repo)
      ).createToken("read", TOKEN_TTL_SECONDS));
    }
    return createGitWireTransport({
      remote: `https://${input.accountId}.artifacts.cloudflare.net/git/${input.namespaceName}/${prefix}${repo}.git`,
      token,
      fetchImpl: input.fetchImpl,
    });
  };

  const tipOid = (refs: { name: string; oid: string }[]): string | undefined =>
    refs.find((r) => r.name === REF)?.oid;

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
      const objects = await transport.fetchObjects({ wants: [tip], deepen: 1 });
      const byOid = new Map<string, RawGitObject>(objects.map((o) => [o.oid, o]));
      const commit = byOid.get(tip);
      if (commit?.type !== "commit") return null;
      const tree = byOid.get(parseCommit(commit.payload).tree);
      if (tree?.type !== "tree") return null;
      const entry = parseTree(tree.payload).find((e) => e.name === name);
      const blob = entry && byOid.get(entry.oid);
      if (blob?.type !== "blob") return null; // absent (a shallow snapshot carries every reachable blob)
      return textDecoder.decode(blob.payload);
    },

    writeFile: async (repo, path, content) => {
      const name = rootName(path);
      const transport = await transportFor(repo, "write");
      const blob = textEncoder.encode(content);
      const blobOid = await hashObject("blob", blob);

      // Merge onto the tip's tree if the repo already has a commit; otherwise this is the first commit.
      const tip = tipOid(await transport.lsRefs([REF]));
      let entries: TreeEntry[] = [];
      const parents: string[] = [];
      if (tip !== undefined) {
        const objects = await transport.fetchObjects({ wants: [tip], deepen: 1 });
        const byOid = new Map<string, RawGitObject>(objects.map((o) => [o.oid, o]));
        const commit = byOid.get(tip);
        if (commit?.type === "commit") {
          const tree = byOid.get(parseCommit(commit.payload).tree);
          if (tree?.type === "tree")
            entries = parseTree(tree.payload).filter((e) => e.name !== name);
          parents.push(tip);
        }
      }
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
