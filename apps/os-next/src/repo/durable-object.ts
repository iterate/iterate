// src/repo/durable-object.ts — THE REPO: the facet a context at ANY path hosts under the name `repo`
// (`itx.repos.get(path)`, library.ts; `/repos/<name>` is the convention, not a rule). A repo's files
// live in git, in Artifacts, behind the stateless `itx.cfArtifacts` (addressed by this same path);
// this host is what makes a repo a DOMAIN OBJECT: `create()` lands the creation facts on its path (the
// certificate cross-posted to `/`, where the project catalog folds it), every commit through it is a
// `repo/commit-completed` fact, and every other method refuses until it is created. The tip's snapshot
// is memoized in memory under the tip it was read at: one `itx.cfArtifacts.tip` per read, the pack
// only when the tip moved.
// build-sdk.mjs bundles THIS module into REPO_PROCESSOR_SOURCE, the spec library.ts hands to `facets.get`.
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { RepoFileChange, RepoLogEntry } from "../context/repos.ts";
import type { RepoIdentity, RepoView } from "./contract.ts";
import { RepoProcessor } from "./processor.ts";

export class RepoDurableObject extends StreamProcessorDurableObject<RepoView> {
  processor = new RepoProcessor();

  /** The context this facet is hosted on IS the repo: its path is the one name it goes by, here and
   *  at `itx.cfArtifacts` (which derives the Artifacts name from it). */
  #pathRead?: string;
  async #path(): Promise<string> {
    if (this.#pathRead) return this.#pathRead;
    const { path } = await this.withItx((itx) => itx.whoami());
    return (this.#pathRead = path);
  }

  /** The tip's snapshot under the tip it was read at — dropped by a commit through this facet,
   *  re-fetched when the remote's tip is not the memo's. */
  #snapshotMemo: { tip: string | null; files: Record<string, string> } | null = null;
  async #fresh(): Promise<{ tip: string | null; files: Record<string, string> }> {
    const path = await this.#path();
    const tip = await this.withItx((itx) => itx.cfArtifacts.tip(path));
    if (this.#snapshotMemo && this.#snapshotMemo.tip === tip) return this.#snapshotMemo;
    const snapshot = await this.withItx((itx) => itx.cfArtifacts.snapshot(path));
    this.#snapshotMemo = snapshot
      ? { tip: snapshot.commitOid, files: snapshot.files }
      : { tip: null, files: {} };
    return this.#snapshotMemo;
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

  async readFile(path: string): Promise<string | null> {
    await this.#created();
    const { files } = await this.#fresh();
    return Object.hasOwn(files, path) ? files[path]! : null;
  }

  async listFiles(): Promise<{ commitOid: string | null; paths: string[] }> {
    await this.#created();
    const { tip, files } = await this.#fresh();
    return { commitOid: tip, paths: Object.keys(files).sort() };
  }

  /** ONE commit on `main` (`itx.cfArtifacts.commitFiles`: compare-and-swapped on the tip, so a
   *  concurrent push refuses it — call again) and `repo/commit-completed` on this path. A batch that
   *  changes nothing commits nothing and appends nothing. */
  async commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    const path = await this.#created();
    this.#snapshotMemo = null; // whatever the outcome, the next read re-fetches
    const committed = await this.withItx((itx) => itx.cfArtifacts.commitFiles(path, input));
    if (committed.changedPaths.length === 0 || !committed.commitOid) return committed;
    await this.withItx((itx) =>
      itx.append({
        type: "events.iterate.com/repo/commit-completed",
        payload: {
          commitOid: committed.commitOid,
          message: input.message,
          changedPaths: committed.changedPaths,
        },
        idempotencyKey: `repo/commit-completed:${committed.commitOid}`,
      }),
    );
    return committed;
  }

  writeFile(
    path: string,
    content: string,
  ): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    return this.commitFiles({ message: `write ${path}`, changes: [{ path, content }] });
  }

  async log(options: { limit?: number } = {}): Promise<RepoLogEntry[]> {
    const path = await this.#created();
    return this.withItx((itx) => itx.cfArtifacts.log(path, options));
  }
}
