// repos.ts — THE PROJECT'S REPOS: the Artifacts binding, one file at a time. Two roots, one prefix:
//   • `itx.cfArtifacts` (`projectScopedArtifacts`) — the RAW Cloudflare Artifacts binding, project-
//     scoped and shaped like the real binding: the control-plane escape hatch (create / get / list /
//     delete a repo; a repo's bytes are git-over-HTTPS, below);
//   • `itx.repos` (`projectScopedRepos`) — the MINIMAL git-backed layer built ON TOP of it +
//     the git wire section below (`createGitWireTransport`, the copied git-over-HTTPS engine): just enough to move the config worker's
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
import { deflate, Inflate } from "pako";

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
 *  object cannot (its `createToken` closure is NonPipelinable and fails to serialize; expression.ts's `InvokeHandle`). */
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

/** Pure and namespace-injected: unit-tests alone (repos.test.ts). */
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

const REF = "refs/heads/main";
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
    // A commit's tree oid is its `tree <oid>` header — read from the header block (before the blank
    // line), never a body line that happens to start "tree ".
    const header = textDecoder.decode(commit.payload).split("\n\n", 1)[0]!;
    const treeOid = header
      .split("\n")
      .find((line) => line.startsWith("tree "))
      ?.slice(5);
    if (treeOid === undefined)
      throw new Error(`itx.repos: the tip commit ${tip} of ${REF} has no tree header`);
    const tree = objects.get(treeOid);
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

// ── git wire ──

/**
 * A minimal git protocol-v2 wire client for the Artifacts git endpoint —
 * exactly what `itx.repos`'s one-file read/write (above) needs, nothing more: `ls-refs`
 * for ONE branch tip (`tipOf`), a shallow `fetch` of the tip's snapshot
 * (`fetchObjects`), `receive-pack` for one commit (`push`), and the object/pack
 * codecs between.
 *
 * The endpoint ("gitty/1.0") was probed empirically; the load-bearing
 * behaviors this module relies on:
 *
 * - `ls-refs` resolves HEAD and branch tips.
 * - `deepen 1` bounds the commit walk to the wanted tip; the snapshot carries
 *   every blob reachable from it.
 * - `filter` is advertised nowhere and silently ignored — never rely on it.
 * - Wants for missing oids are silently dropped: callers must verify receipt.
 * - Packs are self-contained (no thin-pack requested) but interleave types
 *   and may contain ofs- and ref-deltas against in-pack bases.
 */

/** The object kinds the two verbs read and write — a shallow branch-tip fetch carries no tag. */
export type GitObjectType = "blob" | "commit" | "tree";

export interface RawGitObject {
  oid: string;
  payload: Uint8Array;
  type: GitObjectType;
}

const OBJECT_TYPE_CODES: Record<number, GitObjectType | "ofs-delta" | "ref-delta"> = {
  1: "commit",
  2: "tree",
  3: "blob",
  6: "ofs-delta",
  7: "ref-delta",
};
const CODE_BY_TYPE: Record<GitObjectType, number> = { blob: 3, commit: 1, tree: 2 };

// -- pkt-line ----------------------------------------------------------------

function pktLine(line: string): Uint8Array {
  const payload = textEncoder.encode(`${line}\n`);
  return concat([textEncoder.encode((payload.length + 4).toString(16).padStart(4, "0")), payload]);
}

const FLUSH = textEncoder.encode("0000");
const DELIM = textEncoder.encode("0001");

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Walk a pkt-line stream, yielding payloads plus flush/delim markers. */
function* pktFrames(
  body: Uint8Array,
): Generator<{ kind: "delim" | "flush" | "line"; payload: Uint8Array }> {
  let cursor = 0;
  while (cursor + 4 <= body.length) {
    const header = textDecoder.decode(body.subarray(cursor, cursor + 4));
    if (header === "0000") {
      cursor += 4;
      yield { kind: "flush", payload: new Uint8Array(0) };
      continue;
    }
    if (header === "0001") {
      cursor += 4;
      yield { kind: "delim", payload: new Uint8Array(0) };
      continue;
    }
    const length = Number.parseInt(header, 16);
    if (Number.isNaN(length) || length < 4 || cursor + length > body.length) {
      throw new Error(`malformed pkt-line at byte ${cursor} (header ${JSON.stringify(header)})`);
    }
    yield { kind: "line", payload: body.subarray(cursor + 4, cursor + length) };
    cursor += length;
  }
  // A body cut mid-header (1–3 trailing bytes) is a TRUNCATED response, never a complete stream:
  // read as complete, an empty ref list would mean "unborn repo" → "no file" to itx.repos.
  if (cursor !== body.length)
    throw new Error(
      `truncated pkt-line stream: ${body.length - cursor} trailing byte(s) after byte ${cursor}`,
    );
}

function pktText(payload: Uint8Array): string {
  let end = payload.length;
  if (end > 0 && payload[end - 1] === 0x0a) end -= 1;
  return textDecoder.decode(payload.subarray(0, end));
}

// -- object identity ----------------------------------------------------------

async function hashObject(type: GitObjectType, payload: Uint8Array): Promise<string> {
  const framed = concat([textEncoder.encode(`${type} ${payload.length}\0`), payload]);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", framed as BufferSource)));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(oid: string): Uint8Array {
  const out = new Uint8Array(oid.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(oid.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// -- tree and commit codecs ----------------------------------------------------

export interface TreeEntry {
  /** Octal mode string as git writes it: 100644, 100755, 120000, 40000, 160000. */
  mode: string;
  name: string;
  oid: string;
}

function parseTree(payload: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor);
    const nul = payload.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > payload.length) {
      throw new Error(`malformed tree entry at byte ${cursor}`);
    }
    entries.push({
      mode: textDecoder.decode(payload.subarray(cursor, space)),
      name: textDecoder.decode(payload.subarray(space + 1, nul)),
      oid: toHex(payload.subarray(nul + 1, nul + 21)),
    });
    cursor = nul + 21;
  }
  return entries;
}

function encodeTree(entries: TreeEntry[]): Uint8Array {
  // git sorts tree entries as if directory names carried a trailing slash.
  const sortKey = (entry: TreeEntry) => (entry.mode === "40000" ? `${entry.name}/` : entry.name);
  const sorted = [...entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  return concat(
    sorted.map((entry) =>
      concat([textEncoder.encode(`${entry.mode} ${entry.name}\0`), fromHex(entry.oid)]),
    ),
  );
}

function encodeCommit(input: {
  author: { date: Date; email: string; name: string };
  message: string;
  parents: string[];
  tree: string;
}): Uint8Array {
  const stamp = `${input.author.name} <${input.author.email}> ${Math.floor(input.author.date.getTime() / 1000)} +0000`;
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((parent) => `parent ${parent}`),
    `author ${stamp}`,
    `committer ${stamp}`,
    "",
    input.message,
  ];
  return textEncoder.encode(lines.join("\n"));
}

// -- pack parsing ---------------------------------------------------------------

/** Inflate one zlib stream starting at `offset`, reporting consumed bytes. */
function inflateAt(pack: Uint8Array, offset: number): { consumed: number; out: Uint8Array } {
  const inflator = new Inflate();
  const chunks: Uint8Array[] = [];
  inflator.onData = (chunk: Uint8Array) => chunks.push(chunk);
  inflator.onEnd = () => undefined;
  let pushed = 0;
  while (!inflator.ended && offset + pushed < pack.length) {
    const next = Math.min(offset + pushed + 65536, pack.length);
    inflator.push(pack.subarray(offset + pushed, next), false);
    pushed = next - offset;
    if (inflator.err !== 0) throw new Error(`zlib error in pack entry: ${inflator.msg}`);
  }
  if (!inflator.ended) throw new Error("truncated zlib stream in pack");
  // pako does not expose consumed-byte accounting publicly; we rely on its
  // zlib-mirror `strm.avail_in`. Assert the shape so a pako upgrade fails
  // HERE with a clear message instead of corrupting pack cursor arithmetic
  // silently.
  const strm = (inflator as unknown as { strm?: { avail_in?: number } }).strm;
  if (strm === undefined || typeof strm.avail_in !== "number") {
    throw new Error("pako Inflate no longer exposes strm.avail_in — pack parsing cannot proceed");
  }
  return { consumed: pushed - strm.avail_in, out: concat(chunks) };
}

function applyDelta(base: Uint8Array, program: Uint8Array): Uint8Array {
  let cursor = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = program[cursor]!;
      cursor += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const baseSize = varint();
  if (baseSize !== base.length) {
    throw new Error(
      `delta base size mismatch: program expects ${baseSize}, base is ${base.length}`,
    );
  }
  const resultSize = varint();
  const out = new Uint8Array(resultSize);
  let written = 0;
  while (cursor < program.length) {
    const op = program[cursor]!;
    cursor += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) {
          copyOffset |= program[cursor]! << (8 * bit);
          cursor += 1;
        }
      }
      for (let bit = 0; bit < 3; bit++) {
        if (op & (0x10 << bit)) {
          copySize |= program[cursor]! << (8 * bit);
          cursor += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > resultSize) {
        throw new Error(
          `delta copy outside its base (offset ${copyOffset}, size ${copySize}, base ${base.length})`,
        );
      }
      out.set(base.subarray(copyOffset, copyOffset + copySize), written);
      written += copySize;
    } else if (op > 0) {
      out.set(program.subarray(cursor, cursor + op), written);
      cursor += op;
      written += op;
    } else {
      throw new Error("delta opcode 0 is reserved");
    }
  }
  if (written !== resultSize) {
    throw new Error(`delta produced ${written} bytes, expected ${resultSize}`);
  }
  return out;
}

/**
 * Parse a self-contained pack into verified objects, resolving ofs- and
 * ref-deltas against in-pack bases. Every returned oid is recomputed from
 * the payload, and the trailing SHA-1 is checked first.
 */
async function parsePack(pack: Uint8Array): Promise<RawGitObject[]> {
  if (pack.length < 32 || textDecoder.decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("not a pack stream");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", pack.subarray(0, pack.length - 20) as BufferSource),
  );
  if (toHex(digest) !== toHex(pack.subarray(pack.length - 20))) {
    throw new Error("pack checksum mismatch");
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = view.getUint32(8);

  // Phase 1: walk every entry into a descriptor — no delta resolution yet, so
  // legal packs whose deltas reference entries in ANY order (ofs-on-ref
  // included) parse the same way.
  type Entry = {
    baseOffset?: number;
    baseOid?: string;
    offset: number;
    payload: Uint8Array;
    type?: GitObjectType;
  };
  const entries: Entry[] = [];
  const byEntryOffset = new Map<number, Entry>();
  let cursor = 12;
  for (let index = 0; index < count; index++) {
    const entryOffset = cursor;
    let byte = pack[cursor]!;
    cursor += 1;
    const typeCode = (byte >> 4) & 0b111;
    let declaredSize = byte & 0b1111;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[cursor]!;
      cursor += 1;
      declaredSize |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const kind = OBJECT_TYPE_CODES[typeCode];
    if (kind === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const entry: Entry = { offset: entryOffset, payload: new Uint8Array(0) };
    if (kind === "ofs-delta") {
      let distanceByte = pack[cursor]!;
      cursor += 1;
      let distance = distanceByte & 0x7f;
      while (distanceByte & 0x80) {
        distanceByte = pack[cursor]!;
        cursor += 1;
        distance = ((distance + 1) << 7) | (distanceByte & 0x7f);
      }
      entry.baseOffset = entryOffset - distance;
    } else if (kind === "ref-delta") {
      entry.baseOid = toHex(pack.subarray(cursor, cursor + 20));
      cursor += 20;
    } else {
      entry.type = kind;
    }
    const inflated = inflateAt(pack, cursor);
    cursor += inflated.consumed;
    if (inflated.out.length !== declaredSize) {
      throw new Error(
        `pack entry at ${entryOffset} inflated to ${inflated.out.length} bytes, header declared ${declaredSize}`,
      );
    }
    entry.payload = inflated.out;
    entries.push(entry);
    byEntryOffset.set(entryOffset, entry);
  }
  if (cursor !== pack.length - 20) {
    throw new Error(`pack has trailing bytes: parsed to ${cursor}, trailer at ${pack.length - 20}`);
  }

  // Phase 2: resolve each entry through a memoized dependency walk. Delta
  // chains are finite; a cycle or missing base throws.
  const resolved = new Map<Entry, { payload: Uint8Array; type: GitObjectType }>();
  const byOid = new Map<string, { payload: Uint8Array; type: GitObjectType }>();
  const resolving = new Set<Entry>();
  const resolve = (entry: Entry): { payload: Uint8Array; type: GitObjectType } => {
    const done = resolved.get(entry);
    if (done !== undefined) return done;
    if (resolving.has(entry)) throw new Error("delta cycle in pack");
    resolving.add(entry);
    try {
      let out: { payload: Uint8Array; type: GitObjectType };
      if (entry.type !== undefined) {
        out = { payload: entry.payload, type: entry.type };
      } else if (entry.baseOffset !== undefined) {
        const base = byEntryOffset.get(entry.baseOffset);
        if (base === undefined) {
          throw new Error(`ofs-delta base at ${entry.baseOffset} not in pack`);
        }
        const baseResolved = resolve(base);
        out = { payload: applyDelta(baseResolved.payload, entry.payload), type: baseResolved.type };
      } else {
        const base = byOid.get(entry.baseOid!);
        if (base === undefined) {
          // Retryable: a later pass may have hashed this base by then.
          throw new Error(`thin pack: ref-delta base ${entry.baseOid} not in pack`);
        }
        out = { payload: applyDelta(base.payload, entry.payload), type: base.type };
      }
      resolved.set(entry, out);
      return out;
    } finally {
      resolving.delete(entry);
    }
  };
  // Ref-delta bases are found by oid, so hash non-delta entries first, then
  // sweep deltas in passes (a ref-delta may target another delta's RESULT).
  const objects: RawGitObject[] = [];
  const emit = async (entry: Entry) => {
    const out = resolve(entry);
    const oid = await hashObject(out.type, out.payload);
    byOid.set(oid, out);
    objects.push({ oid, ...out });
  };
  for (const entry of entries) if (entry.type !== undefined) await emit(entry);
  let pending = entries.filter((entry) => entry.type === undefined);
  while (pending.length > 0) {
    const next: Entry[] = [];
    for (const entry of pending) {
      try {
        await emit(entry);
      } catch (error) {
        if (String(error).includes("thin pack")) next.push(entry);
        else throw error;
      }
    }
    if (next.length === pending.length) {
      throw new Error(`thin pack: ${next.length} delta(s) reference bases outside the pack`);
    }
    pending = next;
  }
  return objects;
}

/** Build a self-contained pack (no deltas) from raw object payloads. */
async function buildPack(
  objects: { payload: Uint8Array; type: GitObjectType }[],
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set(textEncoder.encode("PACK"), 0);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  parts.push(header);
  for (const object of objects) {
    const bytes: number[] = [];
    let size = object.payload.length;
    let first = (CODE_BY_TYPE[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    bytes.push(first);
    parts.push(Uint8Array.from(bytes));
    parts.push(deflate(object.payload));
  }
  const body = concat(parts);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body as BufferSource));
  return concat([body, digest]);
}

// -- protocol v2 requests --------------------------------------------------------

function encodeFetchRequest(input: { deepen: number; wants: string[] }): Uint8Array {
  const parts = [pktLine("command=fetch"), DELIM];
  for (const want of input.wants) parts.push(pktLine(`want ${want}`));
  parts.push(pktLine(`deepen ${input.deepen}`));
  parts.push(pktLine("no-progress"));
  parts.push(pktLine("done"));
  parts.push(FLUSH);
  return concat(parts);
}

function encodeLsRefsRequest(ref: string): Uint8Array {
  return concat([
    pktLine("command=ls-refs"),
    DELIM,
    pktLine("peel"),
    pktLine(`ref-prefix ${ref}`),
    FLUSH,
  ]);
}

/** The oid of `ref` among the `<oid> <name> [attributes…]` lines (the attributes — peeled, symref
 *  targets — are not read), or undefined when the response names no such ref (an unborn branch). */
function tipOfLsRefs(body: Uint8Array, ref: string): string | undefined {
  for (const frame of pktFrames(body)) {
    if (frame.kind !== "line") continue;
    const [oid, name] = pktText(frame.payload).split(" ");
    if (name === ref) return oid;
  }
  return undefined;
}

/** The pack out of a v2 fetch response: sideband channel 1 after the `packfile` marker; channel 3 is
 *  a fatal from the server. The `acknowledgments`/`shallow-info` sections before it are skipped. */
function demuxFetchResponse(body: Uint8Array): Uint8Array {
  const packChunks: Uint8Array[] = [];
  let inPack = false;
  for (const frame of pktFrames(body)) {
    if (frame.kind !== "line") continue;
    if (inPack) {
      const channel = frame.payload[0];
      if (channel === 1) packChunks.push(frame.payload.subarray(1));
      else if (channel === 3) {
        throw new Error(`fetch failed: ${textDecoder.decode(frame.payload.subarray(1)).trim()}`);
      }
      continue;
    }
    if (pktText(frame.payload) === "packfile") inPack = true;
  }
  return concat(packChunks);
}

// -- receive-pack (push) ----------------------------------------------------------

function encodeReceivePackRequest(input: {
  newOid: string;
  oldOid: string;
  pack: Uint8Array;
  ref: string;
}): Uint8Array {
  const update = `${input.oldOid} ${input.newOid} ${input.ref}\0report-status side-band-64k agent=iterate-repos/1`;
  return concat([pktLine(update), FLUSH, input.pack]);
}

/** null is a PROOF the server moved `expectedRef` (`unpack ok` + `ok <ref>`); anything else — an
 *  explicit `ng`, an unpack failure, a report with no status line for the ref — is the refusal, in
 *  the server's words. */
function pushRefused(body: Uint8Array, expectedRef: string): string | null {
  // The report may arrive sidebanded (channel 1 wraps an inner pkt stream) or
  // plain; sniff the first frame. Channel 3 carries fatal detail.
  const frames = [...pktFrames(body)].filter((frame) => frame.kind === "line");
  const first = frames[0]?.payload ?? new Uint8Array(0);
  const notes: string[] = [];
  let report: Uint8Array;
  if (first.length > 0 && (first[0] === 1 || first[0] === 2 || first[0] === 3)) {
    for (const frame of frames) {
      if (frame.payload[0] === 3) {
        notes.push(textDecoder.decode(frame.payload.subarray(1)).trim());
      }
    }
    report = concat(
      frames.filter((frame) => frame.payload[0] === 1).map((frame) => frame.payload.subarray(1)),
    );
  } else {
    report = body;
  }
  let unpackLine: string | undefined;
  let expectedRefOk = false;
  let expectedRefNg: string | undefined;
  for (const frame of pktFrames(report)) {
    if (frame.kind !== "line") continue;
    const line = pktText(frame.payload);
    if (line.startsWith("unpack ")) unpackLine = line;
    else if (line === `ok ${expectedRef}`) expectedRefOk = true;
    else if (line.startsWith(`ng ${expectedRef} `)) {
      expectedRefNg = line.slice(`ng ${expectedRef} `.length);
    } else if (line.startsWith("ok ") || line.startsWith("ng ")) {
      notes.push(`unexpected ref in report: ${line}`);
    }
  }
  if (unpackLine !== undefined && unpackLine !== "unpack ok") return unpackLine;
  if (expectedRefNg !== undefined) return expectedRefNg;
  if (unpackLine === "unpack ok" && expectedRefOk) return null;
  notes.push(expectedRefOk ? "ok without unpack status" : `no status line for ${expectedRef}`);
  return notes.join("; ");
}

// -- transport ---------------------------------------------------------------------

/**
 * HTTP transport against one Artifacts remote — the three verbs `repos.ts`
 * calls: `tipOf(ref)` (the branch tip's oid, or undefined for an unborn
 * branch), `fetchObjects` (a v2 fetch; the verified objects of the response
 * pack) and `push` (one receive-pack; null when the server moved the ref,
 * else the refusal in its words). `token` is the repo access token Artifacts
 * minted (`createToken` / `create`), sent as a basic-auth password.
 */
export function createGitWireTransport(input: { remote: string; token: string }) {
  const authorization = `Basic ${btoa(`x:${input.token}`)}`;
  const post = async (service: string, body: Uint8Array): Promise<Uint8Array> => {
    const response = await fetch(`${input.remote}/${service}`, {
      body: body as BodyInit,
      headers: {
        authorization,
        "content-type": `application/x-${service}-request`,
        "git-protocol": "version=2",
        "user-agent": "git/2.45.0 (iterate-repos)",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`${service} responded ${response.status} for ${input.remote}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  return {
    fetchObjects: async (request: { deepen: number; wants: string[] }): Promise<RawGitObject[]> =>
      parsePack(demuxFetchResponse(await post("git-upload-pack", encodeFetchRequest(request)))),
    tipOf: async (ref: string): Promise<string | undefined> =>
      tipOfLsRefs(await post("git-upload-pack", encodeLsRefsRequest(ref)), ref),
    push: async (request: {
      newOid: string;
      oldOid: string;
      pack: Uint8Array;
      ref: string;
    }): Promise<string | null> =>
      pushRefused(await post("git-receive-pack", encodeReceivePackRequest(request)), request.ref),
  };
}
