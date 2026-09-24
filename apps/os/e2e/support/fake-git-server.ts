// fake-git-server.ts — an in-memory git REMOTE for the local e2e run: a Node `http` server on
// 127.0.0.1 speaking exactly the protocol-v2 subset the repo facet speaks (src/repo/git-wire.ts,
// whose codecs this reuses — so a pack this serves is a pack the facet parses, and a pack the facet
// pushes is one this parses): `ls-refs` for the tip of `refs/heads/main`, a shallow `fetch` (wants +
// `deepen N` → one pack in sideband-1 frames) and `receive-pack` (one ref update, compare-and-swapped
// on the tip, answered with a report-status). Per repo — keyed by the Artifacts NAME in the URL,
// `/<name>.git/git-upload-pack` — an object store (oid → object) and the tip of `main` (undefined =
// unborn). Auth is ignored. `totalFetches()` counts the `command=fetch` requests served — the FULL
// snapshot fetches the repo facet's memo avoids; an `ls-refs` is not one. `commit`/`seed` land a
// commit from OUTSIDE any facet — "someone else pushed" — through the same codecs the facet uses.
// Reached from inside local workerd through the dynamic worker's outbound fetch (the context DO's
// egress), so the whole wire runs locally; the real endpoint is pinned by e2e/cfartifacts.e2e.test.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { listenOnFetchSafePort } from "@iterate-com/shared/test-support/fetch-safe-port";
import {
  AUTHOR,
  DELIM,
  FLUSH,
  REF,
  ZERO_OID,
  buildPack,
  concat,
  encodeCommit,
  hashObject,
  manifestOf,
  parseCommit,
  parsePack,
  parseTree,
  pktFrames,
  pktLine,
  pktText,
  treeObjectsOf,
  type RawGitObject,
  type RepoFileChange,
  type RepoManifest,
} from "../../src/repo/git-wire.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** One repo: its objects, the tip of `main` (undefined = unborn), and the fetches it has served. */
type FakeRepo = { objects: Map<string, RawGitObject>; tip: string | undefined; fetches: number };

/** A pkt-line is at most 65520 bytes: 4 of length, 1 of band, and this much payload. */
const SIDEBAND_PAYLOAD_MAX = 65515;

/** One sideband pkt-line: `<len><channel><payload>` — binary, so never `pktLine` (which appends a newline). */
function sidebandFrame(channel: 1 | 2 | 3, payload: Uint8Array): Uint8Array {
  const length = (payload.length + 5).toString(16).padStart(4, "0");
  return concat([textEncoder.encode(length), Uint8Array.of(channel), payload]);
}

/** A v2 command request: `command=<name>` and capabilities before the DELIM, the arguments after it
 *  up to the FLUSH (a command with no arguments sends no DELIM). */
function parseCommandRequest(body: Uint8Array): { command: string; args: string[] } {
  let command = "";
  const args: string[] = [];
  let inArgs = false;
  for (const frame of pktFrames(body)) {
    if (frame.kind === "delim") inArgs = true;
    else if (frame.kind === "flush") break;
    else {
      const line = pktText(frame.payload);
      if (inArgs) args.push(line);
      else if (line.startsWith("command=")) command = line.slice("command=".length);
    }
  }
  return { command, args };
}

export class FakeGitServer {
  readonly #repos = new Map<string, FakeRepo>();
  #server: Server | undefined;
  #port = 0;

  /** Listen on 127.0.0.1, an ephemeral fetch-safe port; unref'd, so a server a test forgets never holds vitest. */
  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`fake-git-server: ${request.method} ${request.url}: ${message}`);
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        response.end(`${message}\n`);
      });
    });
    this.#port = await listenOnFetchSafePort(server);
    server.unref();
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The git-over-HTTP URL of `name` — what a client POSTs `git-upload-pack` / `git-receive-pack` under. */
  remote(name: string): string {
    if (!this.#server) throw new Error("fake-git-server: start() first");
    return `http://127.0.0.1:${this.#port}/${name}.git`;
  }

  /** A repo with an unborn `main`; false when it already existed. */
  createRepo(name: string): boolean {
    if (this.#repos.has(name)) return false;
    this.#repos.set(name, { objects: new Map(), tip: undefined, fetches: 0 });
    return true;
  }
  hasRepo(name: string): boolean {
    return this.#repos.has(name);
  }
  deleteRepo(name: string): boolean {
    return this.#repos.delete(name);
  }
  /** Every repo's name, in creation order. */
  repos(): string[] {
    return [...this.#repos.keys()];
  }

  /** The fetches served across every repo. */
  totalFetches(): number {
    let total = 0;
    for (const repo of this.#repos.values()) total += repo.fetches;
    return total;
  }

  /** `main`'s tip, or undefined while unborn. */
  tip(name: string): string | undefined {
    return this.#repo(name).tip;
  }

  /** The tip's files as text (a submodule pointer has none), or null while `main` is unborn. */
  files(name: string): Record<string, string> | null {
    const repo = this.#repo(name);
    if (!repo.tip) return null;
    const files: Record<string, string> = {};
    for (const [path, entry] of this.#manifest(repo)) {
      if (entry.mode === "160000") continue;
      const blob = repo.objects.get(entry.oid);
      if (blob?.type !== "blob")
        throw new Error(`fake-git-server: ${name} lacks the blob of ${path}`);
      files[path] = textDecoder.decode(blob.payload);
    }
    return files;
  }

  /** ONE commit on `main` from OUTSIDE any facet — `changes` applied to the tip's tree (deletes
   *  first), the trees and the commit built with the facet's own codecs, the tip moved. The oid. */
  async commit(name: string, message: string, changes: RepoFileChange[]): Promise<string> {
    const repo = this.#repo(name);
    const manifest = repo.tip ? this.#manifest(repo) : new Map();
    for (const change of changes) if ("delete" in change) manifest.delete(change.path);
    for (const change of changes) {
      if ("delete" in change) continue;
      const payload = textEncoder.encode(change.content);
      const oid = await hashObject("blob", payload);
      repo.objects.set(oid, { oid, type: "blob", payload });
      manifest.set(change.path, { oid, mode: manifest.get(change.path)?.mode ?? "100644" });
    }
    const { rootOid, trees } = await treeObjectsOf(manifest);
    for (const tree of trees) repo.objects.set(tree.oid, { ...tree, type: "tree" });
    const payload = encodeCommit({
      author: { ...AUTHOR, date: new Date() },
      message,
      parents: repo.tip ? [repo.tip] : [],
      tree: rootOid,
    });
    const oid = await hashObject("commit", payload);
    repo.objects.set(oid, { oid, type: "commit", payload });
    repo.tip = oid;
    return oid;
  }

  /** `files` written as one commit (a fresh repo's first; onto the tip otherwise). The oid. */
  seed(name: string, files: Record<string, string>, message = "seed"): Promise<string> {
    return this.commit(
      name,
      message,
      Object.entries(files).map(([path, content]) => ({ path, content })),
    );
  }

  #repo(name: string): FakeRepo {
    const repo = this.#repos.get(name);
    if (!repo) throw new Error(`fake-git-server: no repo "${name}"`);
    return repo;
  }

  /** The tip's tree flattened. */
  #manifest(repo: FakeRepo): RepoManifest {
    if (!repo.tip) return new Map();
    const commit = repo.objects.get(repo.tip);
    if (commit?.type !== "commit")
      throw new Error(`fake-git-server: the tip ${repo.tip} is no commit`);
    const tree = repo.objects.get(parseCommit(commit.payload).tree);
    if (tree?.type !== "tree") throw new Error(`fake-git-server: the tip's tree is missing`);
    return manifestOf(parseTree(tree.payload), repo.objects);
  }

  // ── the wire ──

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = /^\/(.+)\.git\/(git-upload-pack|git-receive-pack)$/.exec(request.url || "");
    const repo = route ? this.#repos.get(route[1]!) : undefined;
    if (!route || !repo || request.method !== "POST") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(`fake-git-server: no such repo or service: ${request.method} ${request.url}\n`);
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(new Uint8Array(chunk as Buffer));
    const body = concat(chunks);
    const service = route[2]!;
    const out =
      service === "git-upload-pack"
        ? await this.#uploadPack(repo, body)
        : await this.#receivePack(repo, body);
    response.writeHead(200, {
      "content-type": `application/x-${service}-result`,
      "cache-control": "no-cache",
    });
    response.end(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  }

  async #uploadPack(repo: FakeRepo, body: Uint8Array): Promise<Uint8Array> {
    const { command, args } = parseCommandRequest(body);
    if (command === "ls-refs") return this.#lsRefs(repo, args);
    if (command === "fetch") {
      repo.fetches += 1;
      return this.#fetch(repo, args);
    }
    throw new Error(`git-upload-pack: unknown command "${command}"`);
  }

  /** `<oid> <ref>` per ref under the requested prefixes (all refs when none), then FLUSH — nothing
   *  while `main` is unborn. */
  #lsRefs(repo: FakeRepo, args: string[]): Uint8Array {
    const prefixes = args
      .filter((arg) => arg.startsWith("ref-prefix "))
      .map((arg) => arg.slice("ref-prefix ".length));
    const lines: Uint8Array[] = [];
    if (repo.tip) {
      const head = args.includes("symref")
        ? `${repo.tip} HEAD symref-target:${REF}`
        : `${repo.tip} HEAD`;
      for (const [name, line] of [
        ["HEAD", head],
        [REF, `${repo.tip} ${REF}`],
      ] as const)
        if (prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix)))
          lines.push(pktLine(line));
    }
    return concat([...lines, FLUSH]);
  }

  /** The commits reachable from the wants, `deepen` generations deep along every parent (a want the
   *  store lacks is dropped silently — the endpoint's behaviour, which the facet verifies receipt
   *  against), with every tree and blob they reference: a `shallow-info` section when deepening,
   *  then `packfile` and the pack in sideband-1 frames, then FLUSH. */
  async #fetch(repo: FakeRepo, args: string[]): Promise<Uint8Array> {
    const wants = args.filter((arg) => arg.startsWith("want ")).map((arg) => arg.slice(5));
    const deepenArg = args.find((arg) => arg.startsWith("deepen "));
    const deepen = deepenArg ? Number(deepenArg.slice("deepen ".length)) : Number.NaN;
    const depthLimit = Number.isInteger(deepen) && deepen > 0 ? deepen : Number.POSITIVE_INFINITY;
    const objects = new Map<string, RawGitObject>();
    const shallow: string[] = [];
    let frontier = wants.filter((oid) => repo.objects.get(oid)?.type === "commit");
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (objects.has(oid)) continue;
        const commit = repo.objects.get(oid)!;
        objects.set(oid, commit);
        const { parents, tree } = parseCommit(commit.payload);
        this.#addTree(repo, objects, tree);
        if (depth >= depthLimit) {
          if (parents.length > 0) shallow.push(oid);
        } else next.push(...parents);
      }
      frontier = next;
    }
    const pack = await buildPack([...objects.values()]);
    const parts: Uint8Array[] = [];
    if (deepenArg) {
      parts.push(pktLine("shallow-info"));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}`));
      parts.push(DELIM);
    }
    parts.push(pktLine("packfile"));
    for (let at = 0; at < pack.length; at += SIDEBAND_PAYLOAD_MAX)
      parts.push(sidebandFrame(1, pack.subarray(at, at + SIDEBAND_PAYLOAD_MAX)));
    parts.push(FLUSH);
    return concat(parts);
  }

  /** `tree` and everything under it into `objects` (a submodule pointer has no object). */
  #addTree(repo: FakeRepo, objects: Map<string, RawGitObject>, oid: string): void {
    if (objects.has(oid)) return;
    const tree = repo.objects.get(oid);
    if (tree?.type !== "tree") throw new Error(`fake-git-server: the store lacks the tree ${oid}`);
    objects.set(oid, tree);
    for (const entry of parseTree(tree.payload)) {
      if (entry.mode === "40000") this.#addTree(repo, objects, entry.oid);
      else if (entry.mode !== "160000") {
        const blob = repo.objects.get(entry.oid);
        if (blob?.type !== "blob")
          throw new Error(`fake-git-server: the store lacks the blob ${entry.oid} (${entry.name})`);
        objects.set(entry.oid, blob);
      }
    }
  }

  /** The command lines (`<old> <new> <ref>\0<capabilities>`) up to the FLUSH, then the pack. ONE
   *  update of `refs/heads/main`, compare-and-swapped on the tip: `unpack ok` + `ok <ref>` when the
   *  objects land and the tip moves; `ng <ref> fetch first` when `old` is not the tip (ZERO_OID while
   *  unborn); `ng <ref> missing necessary objects` when the new commit's tree is not all there. The
   *  report rides sideband channel 1 (the client asked for side-band-64k, and sniffs either way). */
  async #receivePack(repo: FakeRepo, body: Uint8Array): Promise<Uint8Array> {
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    let cursor = 0;
    for (;;) {
      if (cursor + 4 > body.length)
        throw new Error("git-receive-pack: no flush after the commands");
      const header = textDecoder.decode(body.subarray(cursor, cursor + 4));
      cursor += 4;
      if (header === "0000") break;
      const length = Number.parseInt(header, 16);
      if (Number.isNaN(length) || length < 4 || cursor + length - 4 > body.length)
        throw new Error(`git-receive-pack: malformed pkt-line header ${JSON.stringify(header)}`);
      const [update = ""] = pktText(body.subarray(cursor, cursor + length - 4)).split("\0");
      cursor += length - 4;
      const [oldOid = "", newOid = "", ref = ""] = update.split(" ");
      commands.push({ oldOid, newOid, ref });
    }
    const pack = body.subarray(cursor);
    const report = (unpack: string, statuses: string[]): Uint8Array =>
      concat([
        sidebandFrame(1, concat([pktLine(unpack), ...statuses.map((s) => pktLine(s)), FLUSH])),
        FLUSH,
      ]);
    let incoming: RawGitObject[] = [];
    if (pack.length > 0) {
      try {
        incoming = await parsePack(pack);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return report(
          `unpack ${message}`,
          commands.map((c) => `ng ${c.ref} unpacker error`),
        );
      }
    }
    const [command] = commands;
    if (!command || commands.length !== 1)
      return report(
        "unpack ok",
        commands.map((c) => `ng ${c.ref} one ref update per push`),
      );
    if (command.ref !== REF)
      return report("unpack ok", [`ng ${command.ref} only ${REF} exists here`]);
    if (command.oldOid !== (repo.tip || ZERO_OID))
      return report("unpack ok", [`ng ${REF} fetch first`]);
    const candidate = new Map(repo.objects);
    for (const object of incoming) candidate.set(object.oid, object);
    if (command.newOid !== ZERO_OID && !this.#connected(candidate, command.newOid))
      return report("unpack ok", [`ng ${REF} missing necessary objects`]);
    repo.objects = candidate;
    repo.tip = command.newOid === ZERO_OID ? undefined : command.newOid;
    return report("unpack ok", [`ok ${REF}`]);
  }

  /** Is `oid` a commit whose parents exist and whose tree, subtrees and blobs are all in `objects`? */
  #connected(objects: Map<string, RawGitObject>, oid: string): boolean {
    const commit = objects.get(oid);
    if (commit?.type !== "commit") return false;
    const { tree, parents } = parseCommit(commit.payload);
    if (parents.some((parent) => objects.get(parent)?.type !== "commit")) return false;
    const walk = (treeOid: string): boolean => {
      const treeObject = objects.get(treeOid);
      if (treeObject?.type !== "tree") return false;
      return parseTree(treeObject.payload).every((entry) =>
        entry.mode === "40000"
          ? walk(entry.oid)
          : entry.mode === "160000" || objects.get(entry.oid)?.type === "blob",
      );
    };
    return walk(tree);
  }
}
