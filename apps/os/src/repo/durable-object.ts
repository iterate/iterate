// src/repo/durable-object.ts — THE REPO: the facet a context at ANY path hosts under the name `repo`
// (`itx.repos.get(path)`, library.ts; `/repos/<name>` is the convention, not a rule). A repo's files
// live in git, in Cloudflare Artifacts, and THIS facet is the only thing that speaks git (git-wire.ts):
// `itx.cfArtifacts.get(path)` — the binding proxy, addressed by this same path — hands it a token and
// the remote URL, and every read and write here is git-over-HTTPS from inside the facet. It is also
// what makes a repo a DOMAIN OBJECT: it hosts the repo processor (processor.ts) — the creation saga
// `itx.repos.create(path)` opens — every commit through it is a `repo/commit-completed` fact, and every
// method refuses until the certificate has landed (`state.creation`) and again once deletion has been
// asked for (`state.deletion`, the saga `itx.repos.delete(path)` opens).
//
// SCOPE, deliberately small: branch `main` only (REF); text content only. A read is ONE ls-refs, and
// the tip's whole snapshot in one shallow fetch (`deepen: 1`) only when the tip moved — memoized in
// memory under the tip it was read at. A commit is compare-and-swapped on the tip (a concurrent push
// refuses it — no merge; the caller reads again and retries).
// Hosted from `ctx.exports` (first-party-facets.ts): ordinary bundled worker code, git-wire.ts and pako
// with it, reached as `itx.facets.get("repo")` (library.ts).

import { z } from "zod";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { EventInput } from "iterate/next/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import {
  AUTHOR,
  REF,
  ZERO_OID,
  buildPack,
  createGitWireTransport,
  encodeCommit,
  hashObject,
  manifestOf,
  parseCommit,
  parseTree,
  treeObjectsOf,
  type GitObjectType,
  type RawGitObject,
  type RepoFileChange,
  type RepoLogEntry,
  type RepoManifest,
} from "./git-wire.ts";
import { RepoContract, type CommitCompleted, type RepoState } from "./contract.ts";
import { RepoProcessor } from "./processor.ts";

/** How long a minted git credential lives — and how long this facet reuses one before minting again. */
const TOKEN_TTL_SECONDS = 300;
/** Reuse a token only while this much of its life remains — an operation must not outlive it. */
const TOKEN_REUSE_MARGIN_MS = 60_000;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type Transport = ReturnType<typeof createGitWireTransport>;
type TipSnapshot = { manifest: RepoManifest; objects: Map<string, RawGitObject> };

/** A repo-relative FILE path, `notes/log.md`: no leading slash, no empty, `.` or `..` segment. */
function filePath(path: string): string {
  const refusal = `repo: not a repo-relative path (${JSON.stringify(path)})`;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a wire-fed argument (its static type is a claim, not a guarantee, across the capability boundary)
  if (typeof path !== "string") throw new Error(refusal);
  if (path.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(refusal);
  return path;
}

/** The repo's own verbs: its public methods beyond the processor's reads, and the handle type
 *  `itx.repos.get(path)` answers (library.ts `RepoFacet`). */
export const repoVerbs = [
  "tip",
  "readFile",
  "readModules",
  "modules",
  "listFiles",
  "commitFiles",
  "writeFile",
  "log",
] as const;

export class RepoDurableObject extends StreamProcessorDurableObject<
  RepoState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  /** The processor's reads, and the repo's own verbs — what `itx.repos.get(path)` reaches (library.ts). */
  static override publicMethods = [...super.publicMethods, ...repoVerbs];

  processor = new RepoProcessor((call) => this.withItx(call));

  /** The context this facet is hosted on IS the repo: its path is the one name it goes by, here and
   *  at `itx.cfArtifacts` (which derives the Artifacts name from it). */
  #pathRead?: string;
  async #path(): Promise<string> {
    if (this.#pathRead) return this.#pathRead;
    const { path } = await this.withItx((itx) => itx.whoami());
    return (this.#pathRead = path);
  }

  /** The remote the proxy names for this path — fixed for the repo's life; read once per incarnation. */
  #remoteRead?: string;
  async #remote(): Promise<string> {
    if (this.#remoteRead) return this.#remoteRead;
    const path = await this.#path();
    return (this.#remoteRead = await this.withItx((itx) => itx.cfArtifacts.get(path).remote()));
  }

  /** One token per scope, minted by the proxy and reused within its life (minus the margin): a read
   *  is then one ls-refs, not a mint and an ls-refs. A repo that does not exist fails HERE with the
   *  binding's own error — after `create()` that is an outage, never "no files". */
  #tokens: Partial<Record<"read" | "write", { token: string; until: number }>> = {};
  async #transport(scope: "read" | "write"): Promise<Transport> {
    const cached = this.#tokens[scope];
    if (cached && Date.now() < cached.until - TOKEN_REUSE_MARGIN_MS)
      return createGitWireTransport({ remote: await this.#remote(), token: cached.token });
    const path = await this.#path();
    const [remote, minted] = await Promise.all([
      this.#remote(),
      this.withItx((itx) => itx.cfArtifacts.get(path).createToken(scope, TOKEN_TTL_SECONDS)),
    ]);
    this.#tokens[scope] = { token: minted.plaintext, until: Date.now() + TOKEN_TTL_SECONDS * 1000 };
    return createGitWireTransport({ remote, token: minted.plaintext });
  }

  /** The tip's SNAPSHOT — one shallow fetch: the tip's manifest, and every object the pack carried by
   *  oid (the endpoint sends every blob reachable from the tip, so a file's bytes are already here —
   *  `readFile` never fetches twice). A pack that omits the commit or its tree is an OUTAGE, not an
   *  empty tree — git drops wants for missing oids silently, so receipt is verified here. */
  async #tipSnapshot(transport: Transport, tip: string): Promise<TipSnapshot> {
    const objects = new Map<string, RawGitObject>(
      (await transport.fetchObjects({ wants: [tip], deepen: 1 })).map((o) => [o.oid, o]),
    );
    const commit = objects.get(tip);
    if (commit?.type !== "commit")
      throw new Error(`repo: the pack omitted the tip commit ${tip} of ${REF}`);
    const tree = objects.get(parseCommit(commit.payload).tree);
    if (tree?.type !== "tree")
      throw new Error(`repo: the pack omitted the tree of the tip commit ${tip}`);
    return { manifest: manifestOf(parseTree(tree.payload), objects), objects };
  }

  /** The tip's files under the tip they were read at — dropped by a commit through this facet,
   *  re-fetched when the remote's tip is not the memo's. */
  #snapshotMemo: { tip: string | null; files: Record<string, string> } | null = null;
  async #fresh(commitOid?: string): Promise<{ tip: string | null; files: Record<string, string> }> {
    const transport = await this.#transport("read");
    const tip = commitOid || (await transport.tipOf(REF)) || null;
    if (this.#snapshotMemo && this.#snapshotMemo.tip === tip) return this.#snapshotMemo;
    const files: Record<string, string> = {};
    if (tip) {
      const { manifest, objects } = await this.#tipSnapshot(transport, tip);
      for (const [file, entry] of manifest) {
        if (entry.mode === "160000") continue; // a submodule pointer has no text
        const blob = objects.get(entry.oid);
        if (blob?.type !== "blob")
          throw new Error(`repo: the pack omitted the blob of ${file} (${entry.oid})`);
        files[file] = textDecoder.decode(blob.payload);
      }
    }
    return (this.#snapshotMemo = { tip, files });
  }

  /** Every verb starts here: a repo whose certificate has not landed refuses, and so does one whose
   *  deletion has been asked for. Deletion can land at any moment, so the state is read on every
   *  call (in memory once the facet is caught up). */
  async #created(): Promise<string> {
    const path = await this.#path();
    const { state } = await this.snapshot();
    if (state.deletion) throw new Error(`repo ${path}: deleted`);
    if (state.creation?.status !== "created")
      throw new Error(
        `repo ${path}: not created — itx.repos.create(${JSON.stringify(path)}) first`,
      );
    return path;
  }

  /** `main`'s tip at the remote, or null. */
  async tip(): Promise<string | null> {
    await this.#created();
    return (await this.#fresh()).tip;
  }

  async readFile(path: string, options?: { commitOid: string }): Promise<string | null> {
    await this.#created();
    const revision = z
      .object({ commitOid: z.string().regex(/^[a-f0-9]{40}$/) })
      .optional()
      .parse(options);
    const { files } = await this.#fresh(revision?.commitOid);
    return Object.hasOwn(files, path) ? files[path]! : null;
  }

  /** Several files at once, each under the name a loaded worker's module map wants for it —
   *  `readModules({ 'cap.js': 'apps/site/worker.js', 'site.js': 'apps/site/site.js' })` is a
   *  no-build app's whole `source`, one call (a source expression yields ONE value, and the loader
   *  takes the module map). A path that does not exist is a refusal, never a silent hole. */
  async readModules(
    modules: Record<string, string>,
    options?: { commitOid: string },
  ): Promise<Record<string, string>> {
    await this.#created();
    const revision = z
      .object({ commitOid: z.string().regex(/^[a-f0-9]{40}$/) })
      .optional()
      .parse(options);
    const { files } = await this.#fresh(revision?.commitOid);
    const out: Record<string, string> = {};
    for (const [moduleName, path] of Object.entries(
      z.record(z.string(), z.string()).parse(modules),
    )) {
      if (!Object.hasOwn(files, path))
        throw new Error(`readModules: no file at ${JSON.stringify(path)}`);
      out[moduleName] = files[path]!;
    }
    return out;
  }

  /** THE REPO AS A WORKER'S MODULES: every `.js` file at the commit under its own path, and `main`
   *  (default `worker.ts`) as `cap.js`, the loader's main module — so a config repo's relative imports
   *  resolve exactly as they do in the tree, with no module map to keep. THE apex target's source
   *  (project/processor.ts: the seed's and every commit's). The loader takes a module's TEXT only
   *  under a name ending in `.js` (Cloudflare's rule: "Module name must end with '.js'"), so `.js` is
   *  the one extension a sibling module may have; `worker.ts` is a name — the platform's seed — and
   *  it rides as `cap.js`. A `.md`, a `.css`, a `.json` is not a module: a worker that serves one
   *  exports its text from a `.js` file. A commit with no `main` is a refusal, never an empty worker;
   *  a repo file at `cap.js` is shadowed by `main` (the loader's name for it). */
  async modules(options?: { main?: string; commitOid?: string }): Promise<Record<string, string>> {
    await this.#created();
    const { main = "worker.ts", commitOid } =
      z
        .object({
          main: z.string().min(1).optional(),
          commitOid: z
            .string()
            .regex(/^[a-f0-9]{40}$/)
            .optional(),
        })
        .optional()
        .parse(options) ?? {};
    const { files } = await this.#fresh(commitOid);
    if (!Object.hasOwn(files, main))
      throw new Error(`modules: no file at ${JSON.stringify(main)} to be the main module`);
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(files))
      if (path.endsWith(".js")) out[path] = content;
    // `cap.js` is the loader's name for the main module, set LAST: a repo file that happens to sit at
    // `cap.js` is shadowed by `main`, never the other way round.
    out["cap.js"] = files[main]!;
    return out;
  }
  async listFiles(): Promise<{ commitOid: string | null; paths: string[] }> {
    await this.#created();
    const { tip, files } = await this.#fresh();
    return { commitOid: tip, paths: Object.keys(files).sort() };
  }

  /** ONE commit on `main` applying `changes` → the new commit and the paths it changed, and
   *  `repo/commit-completed` on this path. Changes that leave the tree as it was commit nothing and
   *  append nothing: `changedPaths` is empty and `commitOid` the tip (null on an unborn repo). The
   *  push is compare-and-swapped on the tip the changes were applied to: a `main` that moved in the
   *  meantime refuses the commit — call again. */
  async commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    const path = await this.#created();
    if (!input.message.trim())
      throw new Error("repo.commitFiles: message must be a non-empty string");
    if (input.changes.length === 0) throw new Error("repo.commitFiles: changes must name a file");
    this.#snapshotMemo = null; // whatever the outcome, the next read re-fetches
    const transport = await this.#transport("write");
    const tip = (await transport.tipOf(REF)) || null;
    // A fact still OWED from a push that landed without its facts (below: the caller saw the throw)
    // is settled FIRST, word for word (an idempotency key names ONE event) — before this commit can
    // overwrite the debt or land on top of an unpublished tip. The apex follows the fact
    // (project/processor.ts), so a commit in git without it would sit unpublished; a root still
    // refusing the fact refuses this commit too, loud. An owed fact for another commit than the tip
    // never landed (a debt written before a push that was refused or died) or is stale (main moved
    // since): dropped.
    const owed = await this.ctx.storage.get<CommitCompleted>("commit-fact");
    if (owed) {
      if (owed.commitOid === tip) await this.#commitFact(owed);
      else await this.ctx.storage.delete("commit-fact");
    }
    // The tip's snapshot, or an unborn repo's empty one. (A tip whose commit or tree the pack omits
    // THROWS in #tipSnapshot — never a fresh root commit that would repoint `main` at an orphan.)
    const { manifest, objects }: TipSnapshot = tip
      ? await this.#tipSnapshot(transport, tip)
      : { manifest: new Map(), objects: new Map() };
    const toPush: { payload: Uint8Array; type: GitObjectType }[] = [];
    const changedPaths: string[] = [];
    // Deletes first, whatever the order given: a batch is one tree, so a write may take a path a
    // delete in the same batch frees (a directory replaced by a file, or the reverse).
    for (const change of input.changes) {
      if (!("delete" in change)) continue;
      const file = filePath(change.path);
      if (manifest.delete(file)) changedPaths.push(file);
    }
    for (const change of input.changes) {
      if ("delete" in change) continue;
      const file = filePath(change.path);
      // A file is never written where a directory is, nor under a file.
      for (const existing of manifest.keys())
        if (existing.startsWith(`${file}/`) || file.startsWith(`${existing}/`))
          throw new Error(`repo.commitFiles: "${file}" collides with "${existing}"`);
      const blob = textEncoder.encode(change.content);
      const oid = await hashObject("blob", blob);
      const current = manifest.get(file);
      if (current?.oid === oid) continue;
      manifest.set(file, { oid, mode: current ? current.mode : "100644" });
      if (!objects.has(oid)) toPush.push({ payload: blob, type: "blob" });
      changedPaths.push(file);
    }
    if (changedPaths.length === 0) return { commitOid: tip, changedPaths };

    const { rootOid, trees } = await treeObjectsOf(manifest);
    for (const tree of trees)
      if (!objects.has(tree.oid)) toPush.push({ payload: tree.payload, type: "tree" });
    const commitBytes = encodeCommit({
      author: { ...(input.author || AUTHOR), date: new Date() },
      message: input.message,
      parents: tip ? [tip] : [],
      tree: rootOid,
    });
    const commitOid = await hashObject("commit", commitBytes);
    toPush.push({ payload: commitBytes, type: "commit" });
    // The fact this push will owe, kept in storage until it has landed on both logs — so a retry after
    // a lost append lands the same event (above), never a different one under the same key.
    const committed: CommitCompleted = { path, commitOid, message: input.message, changedPaths };
    await this.ctx.storage.put("commit-fact", committed);
    const refused = await transport.push({
      newOid: commitOid,
      oldOid: tip || ZERO_OID,
      pack: await buildPack(toPush),
      ref: REF,
    });
    // The push is compare-and-swapped on the tip read above: `main` having moved in the meantime (a
    // concurrent push) is a refusal like any other — the server's words, and the caller retries.
    // oxlint-disable-next-line iterate/simple-truthiness-check -- push() returns null only on success; an empty-string refusal reason (an `ng <ref>` line with no message) is still a refusal and must throw
    if (refused !== null) {
      await this.ctx.storage.delete("commit-fact"); // nothing landed, nothing owed
      throw new Error(`repo ${path}: the commit was refused: ${refused}`);
    }
    await this.#commitFact(committed);
    return { commitOid, changedPaths };
  }

  /** THE COMMIT'S FACT: cross-posted to `/` FIRST — the project processor follows the config repo's
   *  commits with the apex (project/processor.ts), so a commit whose own-path fact lost its answer is
   *  published anyway — then on this path. Keyed by the commit on both, so landing it again (an owed
   *  fact on a retry, above) lands nothing where it stands. Owed no more once both have landed. */
  async #commitFact(payload: CommitCompleted): Promise<void> {
    const committed: EventInput<typeof RepoContract> = {
      type: "events.iterate.com/repo/commit-completed",
      payload,
      idempotencyKey: `repo/commit-completed:${payload.path}:${payload.commitOid}`,
    };
    await this.withItx((itx) => itx.cd("/").append(committed));
    await this.withItx((itx) => itx.append(committed));
    await this.ctx.storage.delete("commit-fact");
  }

  writeFile(
    path: string,
    content: string,
  ): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    return this.commitFiles({ message: `write ${path}`, changes: [{ path, content }] });
  }

  /** The newest `limit` commits of `main` (default 20), newest first — a shallow fetch that deep. */
  async log(options: { limit?: number } = {}): Promise<RepoLogEntry[]> {
    await this.#created();
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error(`repo.log: limit must be a positive integer (got ${String(limit)})`);
    const transport = await this.#transport("read");
    const tip = await transport.tipOf(REF);
    if (!tip) return [];
    const objects = new Map<string, RawGitObject>(
      (await transport.fetchObjects({ wants: [tip], deepen: limit })).map((o) => [o.oid, o]),
    );
    const entries: RepoLogEntry[] = [];
    let oid: string | undefined = tip;
    while (oid && entries.length < limit) {
      const commit = objects.get(oid);
      if (commit?.type !== "commit") break; // past the shallow boundary
      const { parents, author, timestamp, message } = parseCommit(commit.payload);
      entries.push({ oid, message, author, timestamp, parents });
      oid = parents[0];
    }
    return entries;
  }
}
