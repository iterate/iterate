// git-wire.ts — the one git protocol implementation: the object codecs (blob / tree / commit ids
// exactly as git computes them, a tree flattened to a manifest, a manifest re-encoded to tree
// objects), the pack codec (parse a fetch's pack — zlib entries, ref/ofs deltas resolved — and build a
// push's), the protocol-v2 framing (pkt-line, ls-refs, fetch, receive-pack report-status) and the one
// HTTP transport against a git remote (`createGitWireTransport`: Artifacts, or a repo's origin through
// the context's egress), the remote URL a repo remembers (`gitRemoteOf`) and the ancestry a pull or
// push checks inside the pack it forwards (`commitReaches`). Its callers: the platform's
// repo facet (apps/os/src/repo/durable-object.ts), the anonymous GitHub config-template reader
// (github-template.ts, which brings its own fetch) and, in Node, the local e2e run's fake
// remote (apps/os/e2e/support/fake-git-server.ts) — so a pack the fake serves is a pack the client
// parses. Text content only; a submodule pointer (mode 160000) is carried through a manifest but has
// no blob.

import { deflate, Inflate } from "pako";
import { retryPlatformFailures } from "@iterate-com/shared/platform-retry";

/** The "no such object" oid a first push names as the old value of an unborn ref. */
export const ZERO_OID = "0".repeat(40);
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** A tree FLATTENED: tree-relative path → its entry (blob oid + mode). Every tree object must be in
 *  `objects` (a `deepen 1` pack carries everything reachable from the tip), so the walk fetches
 *  nothing. A submodule pointer (mode 160000) is kept — a re-encoded tree must not drop it — and has
 *  no blob. */
export type RepoManifest = Map<string, { oid: string; mode: string }>;

export function manifestOf(
  entries: TreeEntry[],
  objects: Map<string, RawGitObject>,
  prefix = "",
): RepoManifest {
  const manifest: RepoManifest = new Map();
  for (const entry of entries) {
    const path = prefix + entry.name;
    if (entry.mode === "40000") {
      const tree = objects.get(entry.oid);
      if (tree?.type !== "tree")
        throw new Error(`the pack omitted the tree ${entry.oid} (${path}/)`);
      for (const [nested, nestedEntry] of manifestOf(parseTree(tree.payload), objects, `${path}/`))
        manifest.set(nested, nestedEntry);
    } else manifest.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return manifest;
}

/** The tree objects of a manifest — every directory encoded, children before their parent. Content-
 *  addressed: an unchanged directory hashes to the object the tip already has, which a commit skips. */
export async function treeObjectsOf(
  manifest: RepoManifest,
): Promise<{ rootOid: string; trees: { oid: string; payload: Uint8Array }[] }> {
  // directory path ("" = root) → its files and its subdirectories
  const directories = new Map<string, { files: TreeEntry[]; subdirectories: Set<string> }>();
  const directory = (path: string) => {
    let known = directories.get(path);
    if (!known) directories.set(path, (known = { files: [], subdirectories: new Set() }));
    return known;
  };
  directory("");
  for (const [path, entry] of manifest) {
    const segments = path.split("/");
    let parent = "";
    for (const segment of segments.slice(0, -1)) {
      directory(parent).subdirectories.add(segment);
      parent = parent === "" ? segment : `${parent}/${segment}`;
    }
    directory(parent).files.push({
      mode: entry.mode,
      name: segments[segments.length - 1]!,
      oid: entry.oid,
    });
  }
  const trees: { oid: string; payload: Uint8Array }[] = [];
  const encodeDirectory = async (path: string): Promise<string> => {
    const { files, subdirectories } = directory(path);
    const entries = [...files];
    for (const name of subdirectories)
      entries.push({
        mode: "40000",
        name,
        oid: await encodeDirectory(path === "" ? name : `${path}/${name}`),
      });
    const payload = encodeTree(entries);
    const oid = await hashObject("tree", payload);
    trees.push({ oid, payload });
    return oid;
  };
  return { rootOid: await encodeDirectory(""), trees };
}

/** A commit's headers and message: `tree`, the `parent`s, and the author line
 *  `Name <email> <unix seconds> <tz>` (the timestamp in epoch milliseconds). */
export function parseCommit(payload: Uint8Array): {
  tree: string;
  parents: string[];
  author: { name: string; email: string };
  timestamp: number;
  message: string;
} {
  const text = textDecoder.decode(payload);
  const blank = text.indexOf("\n\n");
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? "" : text.slice(blank + 2).replace(/\n$/, "");
  let tree = "";
  const parents: string[] = [];
  let author = { name: "", email: "" };
  let timestamp = 0;
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) {
      const stamp = /^author (.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
      if (stamp) {
        author = { name: stamp[1]!, email: stamp[2]! };
        timestamp = Number(stamp[3]) * 1000;
      }
    }
  }
  if (!tree) throw new Error("a commit without a tree header");
  return { tree, parents, author, timestamp, message };
}

/**
 * The Artifacts endpoint ("gitty/1.0") was probed empirically; the load-bearing
 * behaviors the repo facet relies on:
 *
 * - `ls-refs` resolves HEAD and branch tips.
 * - `deepen 1` bounds the commit walk to the wanted tip; the snapshot carries
 *   every blob reachable from it.
 * - `filter` is advertised nowhere and silently ignored — never rely on it
 *   (GitHub honours `filter blob:none`, which github.ts uses).
 * - Wants for missing oids are silently dropped: callers must verify receipt.
 * - Packs are self-contained (no thin-pack requested) but interleave types
 *   and may contain ofs- and ref-deltas against in-pack bases.
 */

/** The object kinds read and written — a fetch that wants commits, trees or blobs carries no tag. */
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

// ── pkt-line ──

export function pktLine(line: string): Uint8Array {
  const payload = textEncoder.encode(`${line}\n`);
  return concat([textEncoder.encode((payload.length + 4).toString(16).padStart(4, "0")), payload]);
}

export const FLUSH = textEncoder.encode("0000");
export const DELIM = textEncoder.encode("0001");

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Walk a pkt-line stream, yielding payloads plus flush/delim markers. */
export function* pktFrames(
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

export function pktText(payload: Uint8Array): string {
  let end = payload.length;
  if (end > 0 && payload[end - 1] === 0x0a) end -= 1;
  return textDecoder.decode(payload.subarray(0, end));
}

// ── object identity ──

export async function hashObject(type: GitObjectType, payload: Uint8Array): Promise<string> {
  const framed = concat([textEncoder.encode(`${type} ${payload.length}\0`), payload]);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", framed)));
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

// ── tree and commit codecs ──

interface TreeEntry {
  /** Octal mode string as git writes it: 100644, 100755, 120000, 40000, 160000. */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(payload: Uint8Array): TreeEntry[] {
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

export function encodeCommit(input: {
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

// ── pack parsing ──

/** Inflate one zlib stream starting at `offset`, reporting consumed bytes. It stops as soon as the
 *  output passes `declared`, the size the entry's header states: an untrusted pack cannot make this
 *  isolate allocate more than the header admitted (and `parsePack` bounds). */
function inflateAt(
  pack: Uint8Array,
  offset: number,
  declared: number,
): { consumed: number; out: Uint8Array } {
  const inflator = new Inflate();
  const chunks: Uint8Array[] = [];
  let inflated = 0;
  inflator.onData = (chunk: Uint8Array) => {
    inflated += chunk.length;
    if (inflated > declared)
      throw new Error(`a pack entry inflates past its declared ${declared} byte(s)`);
    chunks.push(chunk);
  };
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
  if (!strm || typeof strm.avail_in !== "number") {
    throw new Error("pako Inflate no longer exposes strm.avail_in — pack parsing cannot proceed");
  }
  return { consumed: pushed - strm.avail_in, out: concat(chunks) };
}

function applyDelta(base: Uint8Array, program: Uint8Array, maxBytes?: number): Uint8Array {
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
  if (maxBytes !== undefined && resultSize > maxBytes)
    throw new Error(`pack object exceeds ${maxBytes} bytes`);
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
 * the payload, and the trailing SHA-1 is checked first. `limits` bound one
 * object's and all objects' inflated bytes (an untrusted remote's pack).
 */
export async function parsePack(
  pack: Uint8Array,
  limits: { maxObjectBytes?: number; maxTotalObjectBytes?: number } = {},
): Promise<RawGitObject[]> {
  const { maxObjectBytes, maxTotalObjectBytes = Infinity } = limits;
  if (pack.length < 32 || textDecoder.decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("not a pack stream");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-1",
      pack.subarray(0, pack.length - 20) as Uint8Array<ArrayBuffer>,
    ),
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
  let declaredBytes = 0;
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
    if (maxObjectBytes !== undefined && declaredSize > maxObjectBytes)
      throw new Error(`pack object exceeds ${maxObjectBytes} bytes`);
    declaredBytes += declaredSize;
    if (declaredBytes > maxTotalObjectBytes)
      throw new Error(`pack objects exceed ${maxTotalObjectBytes} bytes`);
    const kind = OBJECT_TYPE_CODES[typeCode];
    if (!kind) throw new Error(`unknown pack object type ${typeCode}`);
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
    const inflated = inflateAt(pack, cursor, declaredSize);
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
    if (done) return done;
    if (resolving.has(entry)) throw new Error("delta cycle in pack");
    resolving.add(entry);
    try {
      let out: { payload: Uint8Array; type: GitObjectType };
      if (entry.type) {
        out = { payload: entry.payload, type: entry.type };
      } else if (entry.baseOffset !== undefined) {
        const base = byEntryOffset.get(entry.baseOffset);
        if (!base) {
          throw new Error(`ofs-delta base at ${entry.baseOffset} not in pack`);
        }
        const baseResolved = resolve(base);
        out = {
          payload: applyDelta(baseResolved.payload, entry.payload, maxObjectBytes),
          type: baseResolved.type,
        };
      } else {
        const base = byOid.get(entry.baseOid!);
        if (!base) {
          // Retryable: a later pass may have hashed this base by then.
          throw new Error(`thin pack: ref-delta base ${entry.baseOid} not in pack`);
        }
        out = { payload: applyDelta(base.payload, entry.payload, maxObjectBytes), type: base.type };
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
  let resolvedBytes = 0;
  const emit = async (entry: Entry) => {
    const out = resolve(entry);
    resolvedBytes += out.payload.byteLength;
    if (resolvedBytes > maxTotalObjectBytes)
      throw new Error(`pack objects exceed ${maxTotalObjectBytes} bytes`);
    const oid = await hashObject(out.type, out.payload);
    byOid.set(oid, out);
    objects.push({ oid, ...out });
  };
  for (const entry of entries) if (entry.type) await emit(entry);
  let pending = entries.filter((entry) => !entry.type);
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
export async function buildPack(
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  return concat([body, digest]);
}

// ── protocol v2 requests ──

export function encodeFetchRequest(input: {
  deepen?: number;
  filter?: "blob:none";
  wants: string[];
  /** Commits the client already has: the pack leaves out what they reach (a server that does not
   *  know one sends it anyway). */
  haves?: string[];
}): Uint8Array {
  const parts = [pktLine("command=fetch"), DELIM];
  for (const want of input.wants) parts.push(pktLine(`want ${want}`));
  for (const have of input.haves || []) parts.push(pktLine(`have ${have}`));
  if (input.deepen !== undefined) parts.push(pktLine(`deepen ${input.deepen}`));
  if (input.filter) parts.push(pktLine(`filter ${input.filter}`));
  parts.push(pktLine("no-progress"));
  parts.push(pktLine("done"));
  parts.push(FLUSH);
  return concat(parts);
}

export function encodeLsRefsRequest(prefixes: string[]): Uint8Array {
  const parts = [pktLine("command=ls-refs"), DELIM, pktLine("peel")];
  for (const prefix of prefixes) parts.push(pktLine(`ref-prefix ${prefix}`));
  parts.push(FLUSH);
  return concat(parts);
}

/** The `<oid> <name> [attributes…]` lines; `peeledOid` is an annotated tag's commit. */
export function parseLsRefs(body: Uint8Array) {
  const refs: { name: string; oid: string; peeledOid: string | undefined }[] = [];
  for (const frame of pktFrames(body)) {
    if (frame.kind !== "line") continue;
    const [oid, name, ...attributes] = pktText(frame.payload).split(" ");
    if (!oid || !name) continue;
    const peeled = attributes.find((attribute) => attribute.startsWith("peeled:"));
    refs.push({ name, oid, peeledOid: peeled?.slice(7) });
  }
  return refs;
}

/** The pack out of a v2 fetch response: sideband channel 1 after the `packfile` marker; channel 3 is
 *  a fatal from the server. The `acknowledgments`/`shallow-info` sections before it are skipped. */
export function demuxFetchResponse(body: Uint8Array): Uint8Array {
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

// ── receive-pack (push) ──

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
  if (unpackLine && unpackLine !== "unpack ok") return unpackLine;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty-string `ng` reason (`ng <ref> ` with no message) is still a refusal to surface, distinct from undefined (no ng line for the ref)
  if (expectedRefNg !== undefined) return expectedRefNg;
  if (unpackLine === "unpack ok" && expectedRefOk) return null;
  notes.push(expectedRefOk ? "ok without unpack status" : `no status line for ${expectedRef}`);
  return notes.join("; ");
}

// ── remotes and ancestry ──

/** A git remote as git reads one: an http(s) URL with no query or fragment, whose userinfo, if any,
 *  leaves the URL and becomes a Basic credential, as git and curl send it. The userinfo may be
 *  percent-encoded or raw — a secret placeholder (`x-access-token:getSecret("/secrets/github-acme",
 *  { field: "accessToken" })@github.com/…`) has slashes and quotes no URL parser takes in userinfo —
 *  and egress substitutes a placeholder inside the credential (apps/os secrets.ts). */
export function gitRemoteOf(remote: string): {
  url: string;
  authorization: string | null;
  /** The decoded userinfo, or null when the URL has none. */
  userinfo: { user: string; password: string } | null;
} {
  const refusal = () =>
    new Error(`not an http(s) git URL: ${JSON.stringify(redactRemote(remote))}`);
  const match = /^(https?:\/\/)(?:(.*)@)?([^@/?#]+)(\/[^?#]*)?$/.exec(remote);
  if (!match) throw refusal();
  const [, scheme, userinfo, host, path = ""] = match;
  let url: URL;
  try {
    url = new URL(`${scheme}${host}${path}`);
  } catch {
    throw refusal();
  }
  if (!url.hostname) throw refusal();
  const clean = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  if (!userinfo) return { url: clean, authorization: null, userinfo: null };
  const colon = userinfo.indexOf(":");
  const user = decodeUserinfo(colon === -1 ? userinfo : userinfo.slice(0, colon));
  const password = decodeUserinfo(colon === -1 ? "" : userinfo.slice(colon + 1));
  return {
    url: clean,
    authorization: basicAuthorization(`${user}:${password}`),
    userinfo: { user, password },
  };
}

/** `user:password` as a `Basic` Authorization value, UTF-8 first — how git and curl send userinfo,
 *  and how Artifacts takes its minted token. */
export function basicAuthorization(credential: string): string {
  return `Basic ${btoa(String.fromCharCode(...textEncoder.encode(credential)))}`;
}

/** A response body as bytes, read no further than `maxBytes`: a remote that answers more is refused
 *  before this isolate holds it all. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`the remote answered more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
}

/** A userinfo part percent-decoded, or as written when it is not valid percent-encoding. */
function decodeUserinfo(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A remote as it may be shown: everything up to its last `@` dropped after the scheme, whatever the
 *  scheme or its case, so no credential in it is ever echoed. */
export function redactRemote(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^@]*@(?=[^@]*$)/i, "$1");
}

/** Whether `target` is `from` or one of its ancestors, walking every parent through the commits in
 *  `objects` — a pack, which stops at commits the client already has: a parent outside it counts
 *  when it IS the target. So a fetch that wanted `from` and had `target` proves a fast-forward. */
export function commitReaches(
  objects: Map<string, RawGitObject>,
  from: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = objects.get(oid);
    if (commit?.type === "commit") queue.push(...parseCommit(commit.payload).parents);
  }
  return false;
}

// ── transport ──

/** The most one git response may be: a pack for a whole history is buffered here to parse it. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** The wait before the one repeat of a read Artifacts answered 5xx. */
const UPLOAD_PACK_RETRY_DELAYS_MS = [1_000];

/**
 * HTTP transport against one git remote — the verbs the repo facet (repo/durable-object.ts) calls:
 * `tipOf(ref)` (the branch tip's oid, or undefined for an unborn branch), `fetchObjects` (a v2 fetch;
 * the verified objects of the response pack), `fetchPack` (the same fetch's pack bytes, unchanged,
 * to forward to another remote) and `push` (one receive-pack; null when the server moved the ref,
 * else the refusal in its words). `authorization` is the Authorization header: Artifacts' minted
 * token as a Basic password, or a remote's userinfo (`gitRemoteOf`). `fetch` sends the requests: the
 * isolate's own for Artifacts, the context's egress for a repo's origin, where a secret placeholder
 * in the credential is substituted.
 *
 * Artifacts answers a git request 5xx now and then, and the same request a moment later is fine.
 * A `git-upload-pack` (`tipOf`, `fetchObjects`) only reads, so one it answered 5xx is sent ONCE
 * more, `UPLOAD_PACK_RETRY_DELAYS_MS` later, logged as `repo.platform-failure-retry`; a second 5xx,
 * and any other failure, throws. A `git-receive-pack` is a push, never sent twice: the caller reads
 * the tip again and decides.
 */
export function createGitWireTransport(input: {
  remote: string;
  authorization: string | null;
  fetch?: (request: Request) => Promise<Response>;
}) {
  const send = input.fetch || ((request: Request) => fetch(request));
  const post = async (service: string, body: Uint8Array): Promise<Uint8Array> => {
    /** The status the attempt's answer failed with, 0 when it failed before an answer. */
    let failedStatus = 0;
    return retryPlatformFailures(
      async () => {
        failedStatus = 0;
        const headers = new Headers({
          "content-type": `application/x-${service}-request`,
          "git-protocol": "version=2",
          "user-agent": "git/2.45.0 (iterate-repos)",
        });
        // A public remote takes no credential: no Authorization at all, never an empty one.
        if (input.authorization) headers.set("authorization", input.authorization);
        const response = await send(
          new Request(`${input.remote}/${service}`, {
            // Every request body is `concat`'s fresh ArrayBuffer-backed bytes; `BodyInit` names that
            // backing, which the looser `Uint8Array` parameter type does not.
            body: body as Uint8Array<ArrayBuffer>,
            headers,
            method: "POST",
          }),
        );
        if (!response.ok) {
          failedStatus = response.status;
          await response.body?.cancel(); // an unread body keeps its connection open
          throw new Error(`${service} responded ${response.status} for ${input.remote}`);
        }
        return readCapped(response, MAX_RESPONSE_BYTES);
      },
      {
        event: "repo.platform-failure-retry",
        delaysMs: service === "git-upload-pack" ? UPLOAD_PACK_RETRY_DELAYS_MS : [],
        platformFailure: () =>
          failedStatus >= 500
            ? { name: service, status: failedStatus, remote: input.remote }
            : undefined,
      },
    );
  };
  return {
    fetchObjects: async (request: { deepen: number; wants: string[] }): Promise<RawGitObject[]> =>
      parsePack(demuxFetchResponse(await post("git-upload-pack", encodeFetchRequest(request)))),
    fetchPack: async (request: { wants: string[]; haves: string[] }): Promise<Uint8Array> =>
      demuxFetchResponse(await post("git-upload-pack", encodeFetchRequest(request))),
    tipOf: async (ref: string): Promise<string | undefined> =>
      parseLsRefs(await post("git-upload-pack", encodeLsRefsRequest([ref]))).find(
        (entry) => entry.name === ref,
      )?.oid,
    push: async (request: {
      newOid: string;
      oldOid: string;
      pack: Uint8Array;
      ref: string;
    }): Promise<string | null> =>
      pushRefused(await post("git-receive-pack", encodeReceivePackRequest(request)), request.ref),
  };
}
