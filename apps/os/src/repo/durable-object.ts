// src/repo/durable-object.ts — THE REPO: the facet a context at ANY path hosts under the name `repo`
// (`itx.repos.get(path)`, library.ts; `/repos/<name>` is the convention, not a rule). A repo's files
// live in git, in Cloudflare Artifacts, and THIS facet is the only thing that speaks git (git-wire.ts):
// `itx.cfArtifacts.get(path)` — the binding proxy, addressed by this same path — hands it a token and
// the remote URL, and every read and write here is git-over-HTTPS from inside the facet. It is also
// what makes a repo a DOMAIN OBJECT: it hosts the entity lifecycle (src/project/entity-lifecycle.ts:
// the sagas `itx.repos.create(path)` and `itx.repos.delete(path)` open), every commit through it is a
// `repo/commit-completed` fact, and every method refuses until the certificate has landed and again
// once deletion has been asked for.
//
// A repo also keeps ONE REMOTE, as git does (`origin`, a `repo/origin-set` fact in its state), and
// `pull` / `push` keep its main and the remote's main ONE HISTORY: the pack one side's upload-pack
// answers is forwarded, unchanged, to the other side's receive-pack — commits keep their oids and a
// binary file its bytes — fast-forward only unless `force`, proven inside the pack (`commitReaches`).
// The remote is reached through the context's egress, so a secret placeholder in its userinfo
// (`https://x-access-token:getSecret("/secrets/github-acme", …)@github.com/acme/config.git`) is
// substituted there and never enters this facet.
//
// SCOPE, deliberately small: branch `main` only (REF); text content only. A read is ONE ls-refs, and
// the tip's whole snapshot in one shallow fetch (`deepen: 1`) only when the tip moved — memoized in
// memory under the tip it was read at, or the commit this facet pushed. A commit is
// compare-and-swapped on the tip (a concurrent push refuses it — no merge; the caller reads again
// and retries).
// Hosted from `ctx.exports` (first-party-facets.ts): ordinary bundled worker code, the git codec and pako
// with it, reached as `itx.facets.get("repo")` (library.ts).

import { z } from "zod";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { RepoFileChange, RepoLogEntry, RepoSyncResult } from "iterate/api";
import { codedError } from "iterate/lib";
import type { EventInput, ReduceArgs } from "iterate/stream/processor";
import { DurableObjectNameCodec } from "../context/paths.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { assertCreated, EntityLifecycleProcessor } from "../project/entity-lifecycle.ts";
import {
  ZERO_OID,
  buildPack,
  basicAuthorization,
  commitReaches,
  createGitWireTransport,
  encodeCommit,
  hashObject,
  manifestOf,
  gitRemoteOf,
  parseCommit,
  parsePack,
  parseTree,
  readCapped,
  redactRemote,
  treeObjectsOf,
  type GitObjectType,
  type RawGitObject,
  type RepoManifest,
} from "./git-wire.ts";
import { OriginSet, RepoContract, type CommitCompleted, type RepoState } from "./contract.ts";

/** The one branch every repo operation addresses. */
const REF = "refs/heads/main";
/** The author of a commit whose caller named none. */
const AUTHOR = { email: "config@iterate.com", name: "iterate" };
/** How long a minted git credential lives — and how long this facet reuses one before minting again. */
const TOKEN_TTL_SECONDS = 300;
/** Reuse a token only while this much of its life remains — an operation must not outlive it. */
const TOKEN_REUSE_MARGIN_MS = 60_000;
/** The most a pull or push reads and inflates of an untrusted remote: the pack is checked here. */
const MAX_PACK_OBJECT_BYTES = 64 * 1024 * 1024;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type Transport = ReturnType<typeof createGitWireTransport>;
/** A git token as this facet keeps it: reused until `until` (epoch ms) minus the margin. */
type StoredToken = { token: string; until: number };
type TipSnapshot = { manifest: RepoManifest; objects: Map<string, RawGitObject> };
/** A commit's fact, owed from the moment its push is sent until both appends have landed; a pull's
 *  carries a key of its own, since a pull can return main to a commit published before. */
type OwedFact = CommitCompleted & { key?: string };

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
  "modules",
  "listFiles",
  "commitFiles",
  "writeFile",
  "log",
  "origin",
  "setOrigin",
  "pull",
  "push",
] as const;

/** The repo's processor: the entity lifecycle, and the origin its `repo/origin-set` facts name. */
class RepoProcessor extends EntityLifecycleProcessor<RepoState> {
  override reduce(args: ReduceArgs<RepoState>): RepoState | undefined {
    if (args.event.type !== "events.iterate.com/repo/origin-set") return super.reduce(args);
    return { ...args.state, origin: OriginSet.parse(args.event.payload).origin };
  }
}

export class RepoDurableObject extends StreamProcessorDurableObject<
  RepoState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  /** The processor's reads, and the repo's own verbs — what `itx.repos.get(path)` reaches (library.ts). */
  static override publicMethods = [...super.publicMethods, ...repoVerbs];

  /** The entity lifecycle (src/project/entity-lifecycle.ts): its sagas provision the Artifacts repo
   *  (one that exists is fine) and tear it down (false when already gone). */
  processor = new RepoProcessor(
    RepoContract,
    (call) => this.withItx(call),
    () => this.#path,
    {
      provision: (path) => this.withItx((itx) => itx.cfArtifacts.create(path)),
      teardown: (path) => this.withItx((itx) => itx.cfArtifacts.delete(path)),
    },
  );

  /** The context this facet is hosted on IS the repo: its path is the one name it goes by, here and
   *  at `itx.cfArtifacts` (which derives the Artifacts name from it) — the context's name in this
   *  facet's props, so no call reads it. */
  get #path(): string {
    return DurableObjectNameCodec.parse(this.ctx.props.iterateContextName).path;
  }

  // THE GIT CREDENTIALS live in this facet's own storage, not only in memory: a context is evicted
  // soon after it goes idle (apps/os/docs/residency.md), and each fresh incarnation would otherwise
  // ask the proxy again — two dispatches a request, through the context to the root and out to
  // Artifacts. Writes are `allowUnconfirmed`: a credential lost with an unconfirmed write is only
  // asked for again, and the git request after it is not held behind the write. No public method
  // reads these keys; storage trace spans never carry values; the storage goes with the facet when
  // the repo is deleted.

  /** The remote the proxy names for this path — fixed for the repo's life, so asked once and kept
   *  (`git-remote`). */
  #remoteRead?: string;
  async #remote(): Promise<string> {
    this.#remoteRead ||= await this.ctx.storage.get<string>("git-remote");
    if (this.#remoteRead) return this.#remoteRead;
    const path = this.#path;
    const remote = await this.withItx((itx) => itx.cfArtifacts.get(path).remote());
    await this.ctx.storage.put("git-remote", remote, { allowUnconfirmed: true });
    return (this.#remoteRead = remote);
  }

  /** One token per scope, minted by the proxy and reused within its life (minus the margin), kept
   *  (`git-token:<scope>`) so the next incarnation reuses it too: a read is then one ls-refs, not a
   *  mint and an ls-refs. Its life counts from before the mint was asked, so it never outlives the
   *  real one. A repo that does not exist fails its read — at the mint with the binding's own
   *  error, or at the git request with a kept token — after `create()` that is an outage, never "no
   *  files". */
  #tokens: Partial<Record<"read" | "write", StoredToken>> = {};
  async #transport(scope: "read" | "write"): Promise<Transport> {
    const key = `git-token:${scope}`;
    const known = (this.#tokens[scope] ||= await this.ctx.storage.get<StoredToken>(key));
    if (known && Date.now() < known.until - TOKEN_REUSE_MARGIN_MS)
      return createGitWireTransport({
        remote: await this.#remote(),
        authorization: basicAuthorization(`x:${known.token}`),
      });
    const path = this.#path;
    const asked = Date.now();
    const [remote, minted] = await Promise.all([
      this.#remote(),
      this.withItx((itx) => itx.cfArtifacts.get(path).createToken(scope, TOKEN_TTL_SECONDS)),
    ]);
    const token = { token: minted.plaintext, until: asked + TOKEN_TTL_SECONDS * 1000 };
    this.#tokens[scope] = token;
    await this.ctx.storage.put(key, token, { allowUnconfirmed: true });
    return createGitWireTransport({
      remote,
      authorization: basicAuthorization(`x:${minted.plaintext}`),
    });
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

  /** The files of the tip they were read at, or of the commit this facet just pushed — re-fetched
   *  when the remote's tip is not the memo's. A commit's files never change, so the memo answers a
   *  read AT its commit without asking the remote at all: the project's saga reads the seed it just
   *  pushed (project/processor.ts), and Artifacts answered that fetch, right after the push, 500 or
   *  503 (2026-09-24, the latency guard: 2 of the 8 creations that failed in ~1,470). */
  #snapshotMemo: { tip: string | null; files: Record<string, string> } | null = null;
  /** The read AT a commit in flight, one per commitOid: every caller asking for that commit while it
   *  runs waits on it, since its files cannot change. Dropped when it settles, so a rejection is the
   *  next caller's to retry. The memo alone is set only once a read COMPLETES: on prd at 14:36 UTC on
   *  2026-09-24 ~915 concurrent `modules({ commitOid })` calls for one config worker each fetched the
   *  same pack. The loader now asks once per context (worker-loader.ts), but callers of one commit
   *  still overlap here: several contexts, and a `getCode` Cloudflare may run more than once. */
  #snapshotReadsAtCommit = new Map<
    string,
    Promise<{ tip: string | null; files: Record<string, string> }>
  >();
  async #fresh(commitOid?: string): Promise<{ tip: string | null; files: Record<string, string> }> {
    if (!commitOid) return this.#fetchSnapshot();
    if (this.#snapshotMemo?.tip === commitOid) return this.#snapshotMemo;
    let read = this.#snapshotReadsAtCommit.get(commitOid);
    if (!read) {
      read = this.#fetchSnapshot(commitOid).finally(() =>
        this.#snapshotReadsAtCommit.delete(commitOid),
      );
      this.#snapshotReadsAtCommit.set(commitOid, read);
    }
    return read;
  }
  /** The snapshot at `commitOid`, or at the remote's tip: the memo when it is that tip, else one fetch. */
  async #fetchSnapshot(
    commitOid?: string,
  ): Promise<{ tip: string | null; files: Record<string, string> }> {
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

  /** Every verb starts here (`assertCreated`), answering the repo's path. */
  async #created(): Promise<string> {
    const path = this.#path;
    assertCreated("repo", path, (await this.snapshot()).state);
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

  /** THE REPO AS A WORKER'S SOURCE: every file at the commit under its path — or, with `dir`, the
   *  files under that folder, paths relative to it (a folder that is its own worker, like the agents
   *  app's). The loader resolves it (context/module-resolution.ts `entryOf`). */
  async modules(options?: { commitOid?: string; dir?: string }): Promise<Record<string, string>> {
    await this.#created();
    const { commitOid, dir } =
      z
        .object({
          commitOid: z
            .string()
            .regex(/^[a-f0-9]{40}$/)
            .optional(),
          dir: z.string().min(1).optional(),
        })
        .strict()
        .optional()
        .parse(options) ?? {};
    const { files } = await this.#fresh(commitOid);
    if (!dir) return { ...files };
    const prefix = `${dir.replace(/\/$/, "")}/`;
    return Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, content]) => [path.slice(prefix.length), content]),
    );
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
   *  meantime refuses the commit — call again. `parent` names the tip the caller decided on (`null`:
   *  an unborn `main`): a `main` anywhere else refuses the commit before anything is pushed, so a
   *  decision made on an older read never lands on top of a commit it did not see (the project's
   *  seed, project/processor.ts). */
  commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    return this.#serialized(() => this.#commitFiles(input));
  }
  async #commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    const path = await this.#created();
    if (!input.message.trim())
      throw new Error("repo.commitFiles: message must be a non-empty string");
    if (input.changes.length === 0) throw new Error("repo.commitFiles: changes must name a file");
    const parent = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .optional()
      .parse(input.parent);
    this.#snapshotMemo = null; // whatever the outcome, the next read re-fetches — or reads the push's
    const transport = await this.#transport("write");
    const tip = (await transport.tipOf(REF)) || null;
    await this.#settleOwedFact(tip);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `parent` absent commits onto whatever main holds; `null` names an unborn main, which a born one refuses
    if (parent !== undefined && parent !== tip)
      throw new Error(
        `repo ${path}: the commit was refused: main is at ${tip || "no commit (unborn)"}, not at the parent it names (${parent || "unborn"})`,
      );
    // The tip's snapshot, or an unborn repo's empty one. (A tip whose commit or tree the pack omits
    // THROWS in #tipSnapshot — never a fresh root commit that would repoint `main` at an orphan.)
    const { manifest, objects }: TipSnapshot = tip
      ? await this.#tipSnapshot(transport, tip)
      : { manifest: new Map(), objects: new Map() };
    const toPush: { payload: Uint8Array; type: GitObjectType }[] = [];
    const changedPaths: string[] = [];
    /** Each written file's text by its blob's oid: with the snapshot's blobs, the pushed tree's files. */
    const written = new Map<string, string>();
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
      written.set(oid, change.content);
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
    const committed: OwedFact = { path, commitOid, message: input.message, changedPaths };
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
    this.#snapshotMemo = this.#pushedSnapshot(commitOid, manifest, objects, written);
    await this.#commitFact(committed);
    return { commitOid, changedPaths };
  }

  /** The files of the commit just pushed, as `#fresh` would fetch them: every text blob of its tree,
   *  from what was written or the snapshot it was applied to — or null, re-fetched on the next read,
   *  when the snapshot lacks one (a pack that left a blob out). */
  #pushedSnapshot(
    commitOid: string,
    manifest: RepoManifest,
    objects: Map<string, RawGitObject>,
    written: Map<string, string>,
  ): { tip: string; files: Record<string, string> } | null {
    const files: Record<string, string> = {};
    for (const [file, entry] of manifest) {
      if (entry.mode === "160000") continue; // a submodule pointer has no text
      const blob = objects.get(entry.oid);
      if (written.has(entry.oid)) files[file] = written.get(entry.oid)!;
      else if (blob?.type === "blob") files[file] = textDecoder.decode(blob.payload);
      else return null;
    }
    return { tip: commitOid, files };
  }

  /** THE COMMIT'S FACT: cross-posted to `/` FIRST — the project processor follows the config repo's
   *  commits with the apex (project/processor.ts), so a commit whose own-path fact lost its answer is
   *  published anyway — then on this path. Keyed by the commit on both (a pull's by its own key), so
   *  landing it again (an owed fact on a retry) lands nothing where it stands. Owed no more once both
   *  have landed. */
  async #commitFact({ key, ...payload }: OwedFact): Promise<void> {
    const committed: EventInput<typeof RepoContract> = {
      type: "events.iterate.com/repo/commit-completed",
      payload,
      idempotencyKey: key || `repo/commit-completed:${payload.path}:${payload.commitOid}`,
    };
    await this.withItx((itx) => itx.cd("/").append(committed));
    await this.withItx((itx) => itx.append(committed));
    await this.ctx.storage.delete("commit-fact");
  }

  /** A fact still OWED from a commit or pull whose push landed without its facts (the caller saw the
   *  throw) is settled FIRST, word for word (an idempotency key names ONE event) — before a write can
   *  overwrite the debt or land on top of an unpublished tip, and before a pull answers up to date.
   *  The apex follows the fact (project/processor.ts), so a commit in git without it would sit
   *  unpublished; a root still refusing the fact refuses this write too, loud. An owed fact for
   *  another commit than the tip never landed (a debt written before a push that was refused or
   *  died) or is stale (main moved since): dropped. Writes are serialized (`#serialized`), so the one
   *  debt is always the write's own. */
  async #settleOwedFact(tip: string | null): Promise<void> {
    const owed = await this.ctx.storage.get<OwedFact>("commit-fact");
    if (!owed) return;
    if (owed.commitOid === tip) await this.#commitFact(owed);
    else await this.ctx.storage.delete("commit-fact");
  }

  /** ONE WRITE AT A TIME in this facet: a commit and a pull each read the tip, owe a fact and push,
   *  so two at once would overwrite each other's debt. */
  #writes: Promise<unknown> = Promise.resolve();
  #serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(write, write);
    this.#writes = run.catch(() => undefined);
    return run;
  }

  /** The remote this repo remembers, or null. */
  async origin(): Promise<string | null> {
    await this.#created();
    return (await this.snapshot()).state.origin;
  }

  /** Remember `url` as origin, or forget it (`null`): a `repo/origin-set` fact on this path. The URL
   *  must be one git can use, and its credential, if any, a secret placeholder — an origin is stored
   *  on the log, so it never holds a token. A refusal never echoes the credential. */
  async setOrigin(url: string | null): Promise<{ origin: string | null }> {
    const path = await this.#created();
    const origin = z.string().min(1).nullable().parse(url);
    if (origin) {
      const { userinfo } = gitRemoteOf(origin);
      if (userinfo && !/^getSecret\(.*\)$/s.test(userinfo.password))
        throw codedError(
          "INVALID_INPUT",
          `repo ${path}: an origin's credential is a secret placeholder (user:getSecret("/secrets/…")), never a token — ${redactRemote(origin)}`,
        );
    }
    await this.withItx((itx) =>
      itx.append({ type: "events.iterate.com/repo/origin-set", payload: { origin } }),
    );
    return { origin };
  }

  /** Bring the remote's main here, the same commits: its pack goes to Artifacts' receive-pack
   *  unchanged, compare-and-swapped on our tip. Up to date when our main already contains theirs;
   *  refused `NOT_FAST_FORWARD` unless theirs contains ours, or `force` says to reset main to the
   *  remote's (an ancestor of ours included). A pull that moves main lands the commit's fact like
   *  `commitFiles` (so `/repos/config` publishes), owed until it lands. */
  pull(options?: { remote?: string; force?: boolean }): Promise<RepoSyncResult> {
    return this.#serialized(() => this.#pull(options));
  }
  async #pull(options: unknown): Promise<RepoSyncResult> {
    const path = await this.#created();
    const { remote, force } = await this.#syncOptions(options);
    const artifacts = await this.#transport("write");
    const [ours = null, theirs = null] = await Promise.all([
      artifacts.tipOf(REF),
      remote.transport.tipOf(REF),
    ]);
    await this.#settleOwedFact(ours);
    if (!theirs) throw new Error(`repo ${path}: ${remote.shown} has no main to pull`);
    if (theirs === ours) return { status: "up-to-date", commitOid: ours, previousOid: ours };
    const pack = await remote.transport.fetchPack({ wants: [theirs], haves: ours ? [ours] : [] });
    if (ours && !force && !commitReaches(await parseBounded(pack), theirs, ours)) {
      if (await reaches(artifacts, ours, theirs))
        return { status: "up-to-date", commitOid: ours, previousOid: ours };
      throw notFastForward(path, `${remote.shown}'s main does not contain ours`, ours, theirs);
    }
    this.#snapshotMemo = null;
    // The fact this pull owes, read before anything moves: the paths the two tips' trees differ in,
    // and their commit's message, from the remote's own snapshot of it.
    const [before, after] = await Promise.all([
      ours ? this.#tipSnapshot(artifacts, ours) : null,
      this.#tipSnapshot(remote.transport, theirs),
    ]);
    const committed: OwedFact = {
      path,
      commitOid: theirs,
      message: parseCommit(after.objects.get(theirs)!.payload).message,
      changedPaths: changedPathsOf(before?.manifest || new Map(), after.manifest),
      key: `repo/commit-completed:${path}:${theirs}:pull:${crypto.randomUUID()}`,
    };
    await this.ctx.storage.put("commit-fact", committed);
    const refused = await artifacts.push({
      oldOid: ours || ZERO_OID,
      newOid: theirs,
      pack,
      ref: REF,
    });
    // oxlint-disable-next-line iterate/simple-truthiness-check -- push() returns null only on success; an empty-string refusal is still a refusal
    if (refused !== null) {
      await this.ctx.storage.delete("commit-fact");
      throw new Error(`repo ${path}: the pull was refused: ${refused}`);
    }
    await this.#commitFact(committed);
    return { status: "updated", commitOid: theirs, previousOid: ours };
  }

  /** Send this repo's main to the remote's main: Artifacts' pack of what the remote lacks, forwarded
   *  unchanged to its receive-pack, compare-and-swapped on the remote's tip. Up to date when the
   *  remote's main already contains ours; refused `NOT_FAST_FORWARD` unless ours contains theirs, or
   *  `force` says to overwrite it. */
  async push(options?: { remote?: string; force?: boolean }): Promise<RepoSyncResult> {
    const path = await this.#created();
    const { remote, force } = await this.#syncOptions(options);
    const artifacts = await this.#transport("read");
    const [ours = null, theirs = null] = await Promise.all([
      artifacts.tipOf(REF),
      remote.transport.tipOf(REF),
    ]);
    if (!ours) throw new Error(`repo ${path}: main has no commit to push`);
    if (theirs === ours) return { status: "up-to-date", commitOid: ours, previousOid: ours };
    const pack = await artifacts.fetchPack({ wants: [ours], haves: theirs ? [theirs] : [] });
    if (theirs && !force && !commitReaches(await parseBounded(pack), ours, theirs)) {
      if (await reaches(remote.transport, theirs, ours))
        return { status: "up-to-date", commitOid: theirs, previousOid: theirs };
      throw notFastForward(path, `our main does not contain ${remote.shown}'s`, ours, theirs);
    }
    const refused = await remote.transport.push({
      oldOid: theirs || ZERO_OID,
      newOid: ours,
      pack,
      ref: REF,
    });
    // oxlint-disable-next-line iterate/simple-truthiness-check -- push() returns null only on success; an empty-string refusal is still a refusal
    if (refused !== null)
      throw new Error(`repo ${path}: ${remote.shown} refused the push: ${refused}`);
    return { status: "updated", commitOid: ours, previousOid: theirs };
  }

  /** A pull's or push's options, and the remote they name (or origin) as a transport through this
   *  context's egress: the request reaches the remote with the URL's userinfo as its credential,
   *  where egress substitutes a secret placeholder. The body is read — no more than the cap — before
   *  the call ends, so nothing of the egress outlives it. A caller that may pull or push may already
   *  commit to the repo, and a commit to /repos/config publishes code that runs with the root's
   *  egress: this reaches nothing that caller could not. */
  async #syncOptions(options: unknown) {
    const { remote: named, force = false } =
      z
        .object({ remote: z.string().optional(), force: z.boolean().optional() })
        .strict()
        .optional()
        .parse(options) ?? {};
    const url = named || (await this.snapshot()).state.origin;
    if (!url)
      throw codedError(
        "INVALID_INPUT",
        `repo ${this.#path}: no origin — setOrigin(url) first, or name the remote`,
      );
    const { url: remoteUrl, authorization } = gitRemoteOf(url);
    const transport = createGitWireTransport({
      remote: remoteUrl,
      authorization,
      fetch: (request) =>
        this.withItx(async (itx) => {
          const response = await itx.fetch(request);
          return new Response(await readCapped(response, MAX_PACK_OBJECT_BYTES), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }),
    });
    return { force, remote: { transport, shown: redactRemote(url) } };
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

/** An untrusted pack's objects by oid, each object and all of them bounded (git-wire.ts). */
async function parseBounded(pack: Uint8Array): Promise<Map<string, RawGitObject>> {
  const limits = {
    maxObjectBytes: MAX_PACK_OBJECT_BYTES,
    maxTotalObjectBytes: MAX_PACK_OBJECT_BYTES,
  };
  return new Map((await parsePack(pack, limits)).map((object) => [object.oid, object]));
}

/** Whether `tip`'s history on `transport`'s remote contains `oid`: its pack for `tip`, having `oid`,
 *  walked (`commitReaches` — right whether the server honours the have, ignores it, or never saw it). */
async function reaches(transport: Transport, tip: string, oid: string): Promise<boolean> {
  return commitReaches(
    await parseBounded(await transport.fetchPack({ wants: [tip], haves: [oid] })),
    tip,
    oid,
  );
}

/** The paths two trees differ in: added, removed, or another blob or mode — sorted. */
function changedPathsOf(before: RepoManifest, after: RepoManifest): string[] {
  const changed = new Set<string>();
  for (const [file, entry] of after) {
    const was = before.get(file);
    if (was?.oid !== entry.oid || was.mode !== entry.mode) changed.add(file);
  }
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/** The refusal a pull or push without `force` meets when the two mains have diverged. */
function notFastForward(path: string, why: string, ours: string, theirs: string): Error {
  return codedError(
    "NOT_FAST_FORWARD",
    `repo ${path}: not a fast-forward (${why}); pass { force: true } to overwrite`,
    { ours, theirs },
  );
}
