// fake-artifacts.ts — `itx.cfArtifacts` in memory: the binding PROXY and nothing more, lent to a
// repo's context with `itx.cd(path).provide("itx.cfArtifacts", …)` — the repo facet reaches its
// physical tier through its context's rules, so a test fakes it the way it fakes `itx.ai`. Behind it
// a fake git REMOTE (fake-git-server.ts, one per `start()`), which the facet speaks REAL git protocol
// v2 to over HTTP — the same wire codec as against Cloudflare Artifacts, run locally. Keyed by the
// repo's context PATH (`/repos/config`); the Artifacts NAME behind it is derived exactly as the
// platform derives it (src/context/cf-artifacts.ts `repoArtifactName`) and is the remote's URL path. The
// shapes are `ArtifactsScope`'s: `create` / `get(path).{createToken, remote}` / `list` / `delete`.
// `snapshots` counts the FULL fetches the remote served (a `command=fetch`, never an `ls-refs`) —
// what the repo facet's memo avoids. The remote's own side — `remoteTip`, `remoteFiles`,
// `pushFromOutside` — is for a test's eyes, and is never on the real proxy.
import { RpcTarget } from "capnweb";
import { repoArtifactName, repoPathOf } from "../../src/context/cf-artifacts.ts";
import type { RepoFileChange } from "../../src/repo/git-wire.ts";
import { FakeGitServer } from "./fake-git-server.ts";

/** What the fake's `get(path)` hands back — an `RpcTarget` like the real `ScopedArtifactRepoRpcTarget`, so it
 *  crosses the wire and `get(path).createToken(…)` / `.remote()` pipeline; the credential is a
 *  placeholder (the fake remote ignores auth), the remote is the fake server's URL for that repo. */
class FakeArtifactRepo extends RpcTarget {
  readonly #remote: string;
  constructor(remote: string) {
    super();
    this.#remote = remote;
  }
  createToken(_scope: "read" | "write", _ttlSeconds: number): { plaintext: string } {
    return { plaintext: "fake" };
  }
  remote(): string {
    return this.#remote;
  }
}

export class FakeArtifacts extends RpcTarget {
  readonly #server: FakeGitServer;
  /** Every repo path `create` made (not the seeded ones). */
  readonly created: string[] = [];
  /** Every repo path `delete` was asked for, in order — whether or not it still existed. */
  readonly deleted: string[] = [];
  /** How many `create` calls still fail (the creation's failure story). */
  failCreates = 0;

  private constructor(server: FakeGitServer) {
    super();
    this.#server = server;
  }

  /** A listening fake remote, `seed`'s repos (PATH → files) each born with ONE commit ("seed"). */
  static async start(seed: Record<string, Record<string, string>> = {}): Promise<FakeArtifacts> {
    const server = new FakeGitServer();
    await server.start();
    for (const [path, files] of Object.entries(seed)) {
      const name = repoArtifactName(path);
      server.createRepo(name);
      await server.seed(name, files);
    }
    return new FakeArtifacts(server);
  }

  /** How many times a whole tip was fetched, across every repo — a `command=fetch` served by the
   *  remote (the facet's snapshot after a tip move, and its `log`); never an `ls-refs`. */
  get snapshots(): number {
    return this.#server.totalFetches();
  }

  close(): Promise<void> {
    return this.#server.close();
  }

  // ── `ArtifactsScope` (src/context/cf-artifacts.ts) ──

  create(path: string): { created: boolean } {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new Error("artifacts down");
    }
    if (!this.#server.createRepo(repoArtifactName(path))) return { created: false };
    this.created.push(path);
    return { created: true };
  }
  get(path: string): FakeArtifactRepo {
    const name = repoArtifactName(path);
    if (!this.#server.hasRepo(name)) throw new Error(`Repository not found: ${path} (${name})`);
    return new FakeArtifactRepo(this.#server.remote(name));
  }
  /** Every repo, as paths — ONE page, never a cursor. */
  list(): { repos: { path: string }[] } {
    return { repos: this.#server.repos().map((name) => ({ path: repoPathOf(name) })) };
  }
  /** True when the repo existed; false for one already gone — as the proxy's `delete` answers. */
  delete(path: string): boolean {
    this.deleted.push(path);
    return this.#server.deleteRepo(repoArtifactName(path));
  }

  // ── the remote's side, for a test's eyes ──

  /** `main`'s tip at the remote, or null while unborn. */
  remoteTip(path: string): string | null {
    return this.#server.tip(repoArtifactName(path)) ?? null;
  }
  /** The tip's files at the remote, as text — or null while unborn. */
  remoteFiles(path: string): Record<string, string> | null {
    return this.#server.files(repoArtifactName(path));
  }
  /** A commit landing on the remote from OUTSIDE any facet — what a facet's next read must notice. */
  async pushFromOutside(
    path: string,
    input: { message: string; changes: RepoFileChange[] },
  ): Promise<{ commitOid: string }> {
    return {
      commitOid: await this.#server.commit(repoArtifactName(path), input.message, input.changes),
    };
  }
}
