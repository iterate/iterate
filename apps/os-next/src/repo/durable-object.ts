import { z } from "zod";
// src/repo/durable-object.ts — THE REPO: the facet a context at ANY path hosts under the name `repo`
// (`itx.repos.get(path)`, library.ts; `/repos/<name>` is the convention, not a rule). A repo's files
// live in git, in Cloudflare Artifacts, and THIS facet is the only thing that speaks git (git-wire.ts):
// `itx.cfArtifacts.get(path)` — the binding proxy, addressed by this same path — hands it a token and
// the remote URL, and every read and write here is git-over-HTTPS from inside the facet. It is also
// what makes a repo a DOMAIN OBJECT: `create()` lands the creation facts on its path (the certificate
// cross-posted to `/`, where the project catalog folds it), every commit through it is a
// `repo/commit-completed` fact, and every other method refuses until it is created.
//
// SCOPE, deliberately small: branch `main` only (REF); text content only. A read is ONE ls-refs, and
// the tip's whole snapshot in one shallow fetch (`deepen: 1`) only when the tip moved — memoized in
// memory under the tip it was read at. A commit is compare-and-swapped on the tip (a concurrent push
// refuses it — no merge; the caller reads again and retries).
// Hosted from `ctx.exports` (first-party-facets.ts): ordinary bundled worker code, git-wire.ts and pako
// with it, reached as `itx.facets.get("repo")` (library.ts).
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
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
import type { RepoIdentity, RepoView } from "./contract.ts";
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

export class RepoDurableObject extends StreamProcessorDurableObject<
  RepoView,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new RepoProcessor();

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

  /** Bring the repo into being: `repos/create-requested` on this path, the Artifacts repo
   *  provisioned (one that exists is fine), then the certificate on `/` and on this path — or
   *  `repos/create-failed`, thrown; a later `create()` is a new attempt. Idempotent: a created repo
   *  answers at once. Every other method refuses until this has completed. */
  async create(): Promise<RepoIdentity> {
    const path = await this.#path();
    if ((await this.snapshot()).state.creation === "created") return { path };
    await this.withItx((itx) =>
      itx.append({ type: "events.iterate.com/repos/create-requested", payload: { path } }),
    );
    try {
      await this.withItx((itx) => itx.cfArtifacts.create(path));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.withItx((itx) =>
        itx.append({
          type: "events.iterate.com/repos/create-failed",
          payload: { path, error: message },
        }),
      );
      throw new Error(`repo ${path}: creation failed — ${message}`);
    }
    // `/` first, this path last: a cross-post that fails leaves the creation requested, so the next
    // create() runs again (provisioning tolerates an existing repo; the certificate is keyed).
    const certificate = {
      type: "events.iterate.com/repos/created",
      payload: { path },
      idempotencyKey: `repos/created:${path}`,
    };
    await this.withItx((itx) => itx.cd("/").append(certificate));
    await this.withItx((itx) => itx.append(certificate));
    this.#confirmedCreated = true;
    return { path };
  }

  /** Every method past `create()` starts here: a repo not yet created refuses. Creation is terminal,
   *  so one confirming read per incarnation. */
  #confirmedCreated = false;
  async #created(): Promise<string> {
    const path = await this.#path();
    if (!this.#confirmedCreated) {
      if ((await this.snapshot()).state.creation !== "created")
        throw new Error(`repo ${path}: not created — call create() first`);
      this.#confirmedCreated = true;
    }
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
    const refused = await transport.push({
      newOid: commitOid,
      oldOid: tip || ZERO_OID,
      pack: await buildPack(toPush),
      ref: REF,
    });
    // The push is compare-and-swapped on the tip read above: `main` having moved in the meantime (a
    // concurrent push) is a refusal like any other — the server's words, and the caller retries.
    // oxlint-disable-next-line iterate/simple-truthiness-check -- push() returns null only on success; an empty-string refusal reason (an `ng <ref>` line with no message) is still a refusal and must throw
    if (refused !== null) throw new Error(`repo ${path}: the commit was refused: ${refused}`);
    await this.withItx((itx) =>
      itx.append({
        type: "events.iterate.com/repo/commit-completed",
        payload: { commitOid, message: input.message, changedPaths },
        idempotencyKey: `repo/commit-completed:${commitOid}`,
      }),
    );
    return { commitOid, changedPaths };
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
