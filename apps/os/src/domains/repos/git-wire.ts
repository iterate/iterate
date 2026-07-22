import { deflate, Inflate } from "pako";

/**
 * A minimal git protocol-v2 wire client for the Artifacts git endpoint —
 * exactly the primitives the lazy repo read path needs, nothing more.
 *
 * The endpoint ("gitty/1.0") was probed empirically; the load-bearing
 * behaviors this module relies on:
 *
 * - `ls-refs` resolves HEAD and branch tips.
 * - `fetch` accepts wants for ANY object id (not just ref tips): a want for a
 *   blob returns a pack with exactly that blob — the hydration primitive.
 * - `deepen 1` bounds the commit walk to the wanted tip.
 * - A `have` naming a tree INSIDE the want's closure is ACKed and excluded
 *   WITH its whole closure — so "want <new-head>, have <every known dir
 *   tree>" returns only changed subtrees and their blobs. Haves outside the
 *   closure are silently ignored: degradation is over-fetch, never
 *   corruption.
 * - `filter` is advertised nowhere and silently ignored — never rely on it.
 * - Wants for missing oids are silently dropped: callers must verify receipt.
 * - Packs are self-contained (no thin-pack requested) but interleave types
 *   and may contain ofs- and ref-deltas against in-pack bases.
 */

export type GitObjectType = "blob" | "commit" | "tag" | "tree";

export interface RawGitObject {
  oid: string;
  payload: Uint8Array;
  type: GitObjectType;
}

const OBJECT_TYPE_CODES: Record<number, GitObjectType | "ofs-delta" | "ref-delta"> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  6: "ofs-delta",
  7: "ref-delta",
};
const CODE_BY_TYPE: Record<GitObjectType, number> = { blob: 3, commit: 1, tag: 4, tree: 2 };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// -- pkt-line ----------------------------------------------------------------

export function pktLine(line: string): Uint8Array {
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
}

function pktText(payload: Uint8Array): string {
  let end = payload.length;
  if (end > 0 && payload[end - 1] === 0x0a) end -= 1;
  return textDecoder.decode(payload.subarray(0, end));
}

// -- object identity ----------------------------------------------------------

export async function hashObject(type: GitObjectType, payload: Uint8Array): Promise<string> {
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

export function encodeTree(entries: TreeEntry[]): Uint8Array {
  // git sorts tree entries as if directory names carried a trailing slash.
  const sortKey = (entry: TreeEntry) => (entry.mode === "40000" ? `${entry.name}/` : entry.name);
  const sorted = [...entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  return concat(
    sorted.map((entry) =>
      concat([textEncoder.encode(`${entry.mode} ${entry.name}\0`), fromHex(entry.oid)]),
    ),
  );
}

interface CommitFields {
  message: string;
  parents: string[];
  tree: string;
}

export function parseCommit(payload: Uint8Array): CommitFields {
  const raw = textDecoder.decode(payload);
  const headerEnd = raw.indexOf("\n\n");
  const headers = (headerEnd < 0 ? raw : raw.slice(0, headerEnd)).split("\n");
  const tree = headers.find((line) => line.startsWith("tree "))?.slice(5);
  if (tree === undefined) throw new Error("commit without a tree header");
  return {
    message: headerEnd < 0 ? "" : raw.slice(headerEnd + 2),
    parents: headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7)),
    tree,
  };
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
  const strm = (inflator as unknown as { strm: { avail_in: number } }).strm;
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
export async function parsePack(pack: Uint8Array): Promise<RawGitObject[]> {
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
    let out: { payload: Uint8Array; type: GitObjectType };
    if (entry.type !== undefined) {
      out = { payload: entry.payload, type: entry.type };
    } else if (entry.baseOffset !== undefined) {
      const base = byEntryOffset.get(entry.baseOffset);
      if (base === undefined) throw new Error(`ofs-delta base at ${entry.baseOffset} not in pack`);
      const baseResolved = resolve(base);
      out = { payload: applyDelta(baseResolved.payload, entry.payload), type: baseResolved.type };
    } else {
      const base = byOid.get(entry.baseOid!);
      if (base === undefined) {
        throw new Error(`thin pack: ref-delta base ${entry.baseOid} not in pack`);
      }
      out = { payload: applyDelta(base.payload, entry.payload), type: base.type };
    }
    resolving.delete(entry);
    resolved.set(entry, out);
    return out;
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body as BufferSource));
  return concat([body, digest]);
}

// -- protocol v2 requests --------------------------------------------------------

export function encodeFetchRequest(input: {
  deepen?: number;
  haves?: string[];
  wants: string[];
}): Uint8Array {
  const parts = [pktLine("command=fetch"), DELIM];
  for (const want of input.wants) parts.push(pktLine(`want ${want}`));
  for (const have of input.haves ?? []) parts.push(pktLine(`have ${have}`));
  if (input.deepen !== undefined) parts.push(pktLine(`deepen ${input.deepen}`));
  parts.push(pktLine("no-progress"));
  parts.push(pktLine("done"));
  parts.push(FLUSH);
  return concat(parts);
}

export function encodeLsRefsRequest(input: { prefixes: string[] }): Uint8Array {
  const parts = [pktLine("command=ls-refs"), DELIM, pktLine("peel")];
  for (const prefix of input.prefixes) parts.push(pktLine(`ref-prefix ${prefix}`));
  parts.push(FLUSH);
  return concat(parts);
}

export interface LsRefsEntry {
  name: string;
  oid: string;
  symrefTarget?: string;
}

export function parseLsRefs(body: Uint8Array): LsRefsEntry[] {
  const refs: LsRefsEntry[] = [];
  for (const frame of pktFrames(body)) {
    if (frame.kind !== "line") continue;
    const [oid, name, ...attributes] = pktText(frame.payload).split(" ");
    if (oid === undefined || name === undefined) continue;
    const entry: LsRefsEntry = { name, oid };
    for (const attribute of attributes) {
      if (attribute.startsWith("symref-target:")) entry.symrefTarget = attribute.slice(14);
    }
    refs.push(entry);
  }
  return refs;
}

interface FetchResponse {
  acks: string[];
  pack: Uint8Array;
  shallow: string[];
}

export function demuxFetchResponse(body: Uint8Array): FetchResponse {
  const acks: string[] = [];
  const shallow: string[] = [];
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
    const line = pktText(frame.payload);
    if (line === "packfile") inPack = true;
    else if (line.startsWith("ACK ")) acks.push(line.slice(4));
    else if (line.startsWith("shallow ")) shallow.push(line.slice(8));
  }
  return { acks, pack: concat(packChunks), shallow };
}

// -- receive-pack (push) ----------------------------------------------------------

export function encodeReceivePackRequest(input: {
  newOid: string;
  oldOid: string;
  pack: Uint8Array;
  ref: string;
}): Uint8Array {
  const update = `${input.oldOid} ${input.newOid} ${input.ref}\0report-status side-band-64k agent=iterate-lazy-git/1`;
  return concat([pktLine(update), FLUSH, input.pack]);
}

export function parseReceivePackResponse(
  body: Uint8Array,
  expectedRef: string,
): { ok: boolean; refErrors: string[] } {
  // The report may arrive sidebanded (channel 1 wraps an inner pkt stream) or
  // plain; sniff the first frame. Channel 3 carries fatal detail.
  const frames = [...pktFrames(body)].filter((frame) => frame.kind === "line");
  const first = frames[0]?.payload ?? new Uint8Array(0);
  const refErrors: string[] = [];
  let report: Uint8Array;
  if (first.length > 0 && (first[0] === 1 || first[0] === 2 || first[0] === 3)) {
    for (const frame of frames) {
      if (frame.payload[0] === 3) {
        refErrors.push(textDecoder.decode(frame.payload.subarray(1)).trim());
      }
    }
    report = concat(
      frames.filter((frame) => frame.payload[0] === 1).map((frame) => frame.payload.subarray(1)),
    );
  } else {
    report = body;
  }
  let unpackOk = false;
  let expectedRefOk = false;
  for (const frame of pktFrames(report)) {
    if (frame.kind !== "line") continue;
    const line = pktText(frame.payload);
    if (line === "unpack ok") unpackOk = true;
    else if (line.startsWith("unpack ")) refErrors.push(line);
    else if (line === `ok ${expectedRef}`) expectedRefOk = true;
    else if (line.startsWith("ok ")) refErrors.push(`unexpected ref updated: ${line.slice(3)}`);
    else if (line.startsWith("ng ")) {
      const [, ref, ...reason] = line.split(" ");
      refErrors.push(`${ref}: ${reason.join(" ")}`);
    }
  }
  // Success is EXACTLY: unpack ok + a status line confirming OUR ref. A
  // truncated report (unpack ok, then nothing) must read as failure — the
  // caller treats non-ok as rejected/unknown, never as applied.
  if (unpackOk && !expectedRefOk && refErrors.length === 0) {
    refErrors.push(`no status line for ${expectedRef} in the receive-pack report`);
  }
  return { ok: unpackOk && expectedRefOk && refErrors.length === 0, refErrors };
}

// -- transport ---------------------------------------------------------------------

export interface GitWireTransport {
  lsRefs(prefixes: string[]): Promise<LsRefsEntry[]>;
  /** Send a v2 fetch; returns verified objects from the response pack. */
  fetchObjects(input: {
    deepen?: number;
    haves?: string[];
    wants: string[];
  }): Promise<RawGitObject[]>;
  push(input: { newOid: string; oldOid: string; pack: Uint8Array; ref: string }): Promise<{
    ok: boolean;
    refErrors: string[];
  }>;
}

/**
 * HTTP transport against one Artifacts remote. `token` is the repo access
 * token (the same credential the clone lane uses as a basic-auth password).
 */
export function createGitWireTransport(input: {
  fetchImpl?: typeof fetch;
  remote: string;
  token: string;
}): GitWireTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const authorization = `Basic ${btoa(`x:${input.token}`)}`;
  const post = async (service: string, body: Uint8Array): Promise<Uint8Array> => {
    const response = await fetchImpl(`${input.remote}/${service}`, {
      body: body as BodyInit,
      headers: {
        authorization,
        "content-type": `application/x-${service}-request`,
        "git-protocol": "version=2",
        "user-agent": "git/2.45.0 (iterate-lazy-git)",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`${service} responded ${response.status} for ${input.remote}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  return {
    fetchObjects: async (request) =>
      parsePack(
        demuxFetchResponse(await post("git-upload-pack", encodeFetchRequest(request))).pack,
      ),
    lsRefs: async (prefixes) =>
      parseLsRefs(await post("git-upload-pack", encodeLsRefsRequest({ prefixes }))),
    push: async (request) =>
      parseReceivePackResponse(
        await post("git-receive-pack", encodeReceivePackRequest(request)),
        request.ref,
      ),
  };
}
