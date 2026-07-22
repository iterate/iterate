import { deflate } from "pako";
import { describe, expect, test } from "vitest";
import {
  buildPack,
  demuxFetchResponse,
  encodeCommit,
  encodeFetchRequest,
  encodeLsRefsRequest,
  encodeReceivePackRequest,
  encodeTree,
  hashObject,
  parseCommit,
  parseLsRefs,
  parsePack,
  parseReceivePackResponse,
  parseTree,
  pktLine,
} from "./git-wire.ts";

const b64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const text = new TextEncoder();

// Real-git fixtures (generated with fixed author/committer dates):
//   commit ba0a2e449614b24a48ce29d49af86c49ab955576
//   └─ tree d57451d923cb55eb65a0c1cee4b8ee4cdf6b3d5d
//      ├─ a.txt  100644 ce013625030ba8dba906f756967f9e9ca394464a  "hello\n"
//      ├─ link   120000 8d14cbf983b3fad683171c9418998d9f68340823  -> a.txt
//      ├─ sub/    40000 721eea743f274b162a059c0032155c36a62cd740
//      │  └─ b.txt 100644 cc628ccd10742baea8241c5924df992b5c019f71 "world\n"
//      └─ tool   100755 4163036efa65bd4a469e752267498f01ea36a55c
const FIXTURE_COMMIT_OID = "ba0a2e449614b24a48ce29d49af86c49ab955576";
const FIXTURE_TREE_OID = "d57451d923cb55eb65a0c1cee4b8ee4cdf6b3d5d";
const FIXTURE_PACK = b64(
  "UEFDSwAAAAIAAAAHlQp4nJWLQQrDIBBF955i9oGi0dEEQumq99CZkboIAZlAjh+hvUD/4i0+72kXAcYU0PE6eyqIUiJmS45EQlkGiGssnpFNPvVzdHi3S88usNV2vZpKzyoPOvYnuBSTn70NCJMdM+Pdmw7ln8jUn/utzQ3LjjNirwd4nDM0MDAzMVFI1CupKGE4x2imysy94vZKtu9h0+rnzVk8xc3L0MgACBRyMvOyGXpFTv9s3vzrWrO4zBSJmb3zM0w4lE3A0sWlSQxFcq9K7NW9xbRY5zAYicaYLdO57mBoYGBuaqpQkp+fw+CYzJz3K3Wvl9u8UqV0z37GV2ZLYwAFOyxdNnicy0jNycnnAgAISwIfNXicS9QrqSgBAAViAfChAnicMzQwMDMxUUjSK6koYTiT1HNWoER73QoVmUiV+zO1YxjnFwIAs7ALmTZ4nCvPL8pJ4QIACNkCM7IBeJxTVtRPyszTL87gSk3OyFfIyOQCADFWBVuIyFIGdcxXD1nifFEOn0l7yFjqVQ==",
);
const FIXTURE_TREE_PAYLOAD = b64(
  "MTAwNjQ0IGEudHh0AM4BNiUDC6jbqQb3VpZ/npyjlEZKMTIwMDAwIGxpbmsAjRTL+YOz+taDFxyUGJmNn2g0CCM0MDAwMCBzdWIAch7qdD8nSxYqBZwAMhVcNqYs10AxMDA3NTUgdG9vbABBYwNu+mW9SkaedSJnSY8B6jalXA==",
);
const FIXTURE_COMMIT_PAYLOAD = text.encode(
  "tree d57451d923cb55eb65a0c1cee4b8ee4cdf6b3d5d\n" +
    "author Fixture <fix@iterate.com> 1767323045 +0000\n" +
    "committer Fixture <fix@iterate.com> 1767323045 +0000\n" +
    "\n" +
    "fixture commit\n",
);

describe("pkt-line codec", () => {
  test("pktLine frames text with its own length and a newline", () => {
    expect(new TextDecoder().decode(pktLine("command=fetch"))).toBe("0012command=fetch\n");
  });
});

describe("object hashing", () => {
  test("matches git's canonical oids", async () => {
    await expect(hashObject("blob", new Uint8Array(0))).resolves.toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
    await expect(hashObject("blob", text.encode("hello\n"))).resolves.toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    await expect(hashObject("tree", new Uint8Array(0))).resolves.toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
  });
});

describe("tree codec", () => {
  test("parses a real git tree with every entry kind", () => {
    expect(parseTree(FIXTURE_TREE_PAYLOAD)).toEqual([
      { mode: "100644", name: "a.txt", oid: "ce013625030ba8dba906f756967f9e9ca394464a" },
      { mode: "120000", name: "link", oid: "8d14cbf983b3fad683171c9418998d9f68340823" },
      { mode: "40000", name: "sub", oid: "721eea743f274b162a059c0032155c36a62cd740" },
      { mode: "100755", name: "tool", oid: "4163036efa65bd4a469e752267498f01ea36a55c" },
    ]);
  });

  test("encodeTree reproduces git's bytes and therefore its oid", async () => {
    const encoded = encodeTree(parseTree(FIXTURE_TREE_PAYLOAD));
    expect(encoded).toEqual(FIXTURE_TREE_PAYLOAD);
    await expect(hashObject("tree", encoded)).resolves.toBe(FIXTURE_TREE_OID);
  });

  test("encodeTree applies git's directory-aware name ordering", async () => {
    // git sorts tree entries as if directories end in "/": "sub.x" < "sub/" < "sub0".
    const dir = { mode: "40000", name: "sub", oid: FIXTURE_TREE_OID };
    const before = { mode: "100644", name: "sub.x", oid: FIXTURE_TREE_OID };
    const after = { mode: "100644", name: "sub0", oid: FIXTURE_TREE_OID };
    const encoded = encodeTree([after, dir, before]);
    expect(parseTree(encoded).map((entry) => entry.name)).toEqual(["sub.x", "sub", "sub0"]);
  });
});

describe("commit codec", () => {
  test("parses tree, parents, and message from a real commit", () => {
    const commit = parseCommit(FIXTURE_COMMIT_PAYLOAD);
    expect(commit.tree).toBe(FIXTURE_TREE_OID);
    expect(commit.parents).toEqual([]);
    expect(commit.message).toBe("fixture commit\n");
  });

  test("encodeCommit reproduces git's bytes and oid", async () => {
    const encoded = encodeCommit({
      author: { date: new Date(1767323045000), email: "fix@iterate.com", name: "Fixture" },
      message: "fixture commit\n",
      parents: [],
      tree: FIXTURE_TREE_OID,
    });
    expect(encoded).toEqual(FIXTURE_COMMIT_PAYLOAD);
    await expect(hashObject("commit", encoded)).resolves.toBe(FIXTURE_COMMIT_OID);
  });
});

describe("pack parsing", () => {
  test("parses a real git pack: all seven objects, verified oids", async () => {
    const objects = await parsePack(FIXTURE_PACK);
    const byOid = new Map(objects.map((object) => [object.oid, object]));
    expect(objects).toHaveLength(7);
    expect(byOid.get(FIXTURE_COMMIT_OID)?.type).toBe("commit");
    expect(byOid.get(FIXTURE_TREE_OID)?.type).toBe("tree");
    expect(byOid.get("ce013625030ba8dba906f756967f9e9ca394464a")?.type).toBe("blob");
    expect(
      new TextDecoder().decode(byOid.get("cc628ccd10742baea8241c5924df992b5c019f71")?.payload),
    ).toBe("world\n");
  });

  test("rejects a corrupted trailer", async () => {
    const corrupted = FIXTURE_PACK.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    await expect(parsePack(corrupted)).rejects.toThrow(/checksum/);
  });

  test("buildPack round-trips through parsePack", async () => {
    const objects = [
      { payload: text.encode("hello\n"), type: "blob" as const },
      { payload: FIXTURE_TREE_PAYLOAD, type: "tree" as const },
      { payload: FIXTURE_COMMIT_PAYLOAD, type: "commit" as const },
    ];
    const parsed = await parsePack(await buildPack(objects));
    expect(parsed.map((object) => object.oid).sort()).toEqual(
      [FIXTURE_COMMIT_OID, FIXTURE_TREE_OID, "ce013625030ba8dba906f756967f9e9ca394464a"].sort(),
    );
  });

  test("resolves ref-delta and ofs-delta entries", async () => {
    // Handcraft a pack: base blob, a ref-delta on it, and an ofs-delta on it.
    // Delta program: copy base[0..6) + insert "brave " + copy base[6..12).
    const base = text.encode("hello world\n");
    const target = text.encode("hello brave world\n");
    const program = Uint8Array.from([
      base.length, // base size varint (fits one byte)
      target.length, // result size varint
      0b10010000,
      6, // copy: offset 0 (no offset bytes), one size byte = 6
      6,
      ...text.encode("brave "), // insert 6 literal bytes
      0b10010001,
      6,
      6, // copy: one offset byte = 6, one size byte = 6
    ]);
    // Every fixture size fits the header's 4 inline size bits.
    const header = (type: number, size: number) => {
      expect(size).toBeLessThanOrEqual(15);
      return Uint8Array.from([(type << 4) | size]);
    };
    const packParts: Uint8Array[] = [];
    const push = (part: Uint8Array) => packParts.push(part);
    // header: PACK v2, 3 objects
    push(Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 3]));
    let offset = 12;
    // entry 1: base blob (type 3)
    const baseHeader = header(3, base.length);
    const baseBody = deflate(base);
    const baseOffset = offset;
    push(baseHeader);
    push(baseBody);
    offset += baseHeader.length + baseBody.length;
    // entry 2: ref-delta (type 7) against the base oid
    const baseOid = await hashObject("blob", base);
    const refHeader = header(7, program.length);
    const refOidBytes = Uint8Array.from(
      baseOid.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
    );
    const refBody = deflate(program);
    push(refHeader);
    push(refOidBytes);
    push(refBody);
    offset += refHeader.length + refOidBytes.length + refBody.length;
    // entry 3: ofs-delta (type 6) pointing back to the base entry
    const ofsHeader = header(6, program.length);
    const distance = offset - baseOffset;
    expect(distance).toBeLessThan(128); // single-byte negative offset in this fixture
    push(ofsHeader);
    push(Uint8Array.from([distance]));
    push(deflate(program));
    const withoutTrailer = new Uint8Array(packParts.reduce((n, p) => n + p.length, 0));
    let cursor = 0;
    for (const part of packParts) {
      withoutTrailer.set(part, cursor);
      cursor += part.length;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", withoutTrailer));
    const pack = new Uint8Array(withoutTrailer.length + 20);
    pack.set(withoutTrailer, 0);
    pack.set(digest, withoutTrailer.length);

    const parsed = await parsePack(pack);
    const targetOid = await hashObject("blob", target);
    const resolved = parsed.filter((object) => object.oid === targetOid);
    expect(resolved).toHaveLength(2); // ref-delta and ofs-delta both resolve
    expect(new TextDecoder().decode(resolved[0]!.payload)).toBe("hello brave world\n");
  });
});

describe("protocol v2 requests", () => {
  test("fetch request carries wants, haves, deepen, and done in probe-proven order", () => {
    const body = new TextDecoder().decode(
      encodeFetchRequest({
        deepen: 1,
        haves: ["b".repeat(40)],
        wants: ["a".repeat(40)],
      }),
    );
    expect(body).toBe(
      "0012command=fetch\n0001" +
        `0032want ${"a".repeat(40)}\n` +
        `0032have ${"b".repeat(40)}\n` +
        "000ddeepen 1\n" +
        "0010no-progress\n" +
        "0009done\n" +
        "0000",
    );
  });

  test("ls-refs request and response round-trip", () => {
    const body = new TextDecoder().decode(encodeLsRefsRequest({ prefixes: ["refs/heads/"] }));
    expect(body).toBe("0014command=ls-refs\n00010009peel\n001bref-prefix refs/heads/\n0000");
    const oid = "35ea948eecf93a339a72ffed25fdbf51836fbfea";
    const response = pktConcat([
      pktLine(`${oid} HEAD symref-target:refs/heads/main`),
      pktLine(`${oid} refs/heads/main`),
      text.encode("0000"),
    ]);
    expect(parseLsRefs(response)).toEqual([
      { name: "HEAD", oid, symrefTarget: "refs/heads/main" },
      { name: "refs/heads/main", oid },
    ]);
  });
});

function pktConcat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

describe("fetch response demux", () => {
  test("collects acks, shallow info, and de-sidebands the pack", () => {
    const packBytes = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 1, 2, 3]);
    const sideband = new Uint8Array(1 + packBytes.length);
    sideband[0] = 1;
    sideband.set(packBytes, 1);
    const sidebandPkt = new Uint8Array(4 + sideband.length);
    sidebandPkt.set(text.encode(`${(4 + sideband.length).toString(16).padStart(4, "0")}`), 0);
    sidebandPkt.set(sideband, 4);
    const response = pktConcat([
      pktLine("acknowledgments"),
      pktLine("ACK deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
      pktLine("ready"),
      text.encode("0001"),
      pktLine("shallow-info"),
      pktLine("shallow deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
      text.encode("0001"),
      pktLine("packfile"),
      sidebandPkt,
      text.encode("0000"),
    ]);
    const demuxed = demuxFetchResponse(response);
    expect(demuxed.acks).toEqual(["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
    expect(demuxed.pack).toEqual(packBytes);
  });

  test("surfaces sideband channel-3 errors", () => {
    const errorBand = text.encode("fatal: something broke");
    const errorPkt = pktConcat([
      pktLine("packfile"),
      text.encode(`${(4 + errorBand.length).toString(16).padStart(4, "0")}`),
      errorBand,
      text.encode("0000"),
    ]);
    expect(() => demuxFetchResponse(errorPkt)).toThrow(/something broke/);
  });
});

describe("receive-pack", () => {
  test("frames the ref update ahead of the pack", async () => {
    const pack = await buildPack([{ payload: text.encode("x"), type: "blob" }]);
    const request = encodeReceivePackRequest({
      newOid: "b".repeat(40),
      oldOid: "a".repeat(40),
      pack,
      ref: "refs/heads/main",
    });
    const decoded = new TextDecoder().decode(request.slice(0, 200));
    expect(decoded).toContain(`${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main\0`);
    expect(decoded).toContain("report-status");
    expect(request.slice(-pack.length)).toEqual(pack);
  });

  test("parses success and rejection reports, sidebanded or plain", () => {
    const plain = pktConcat([
      pktLine("unpack ok"),
      pktLine("ok refs/heads/main"),
      text.encode("0000"),
    ]);
    expect(parseReceivePackResponse(plain)).toEqual({ ok: true, refErrors: [] });

    const rejected = pktConcat([
      pktLine("unpack ok"),
      pktLine("ng refs/heads/main non-fast-forward"),
      text.encode("0000"),
    ]);
    expect(parseReceivePackResponse(rejected)).toEqual({
      ok: false,
      refErrors: ["refs/heads/main: non-fast-forward"],
    });

    const inner = pktConcat([
      pktLine("unpack ok"),
      pktLine("ok refs/heads/main"),
      text.encode("0000"),
    ]);
    const band = new Uint8Array(1 + inner.length);
    band[0] = 1;
    band.set(inner, 1);
    const sidebanded = pktConcat([
      text.encode(`${(4 + band.length).toString(16).padStart(4, "0")}`),
      band,
      text.encode("0000"),
    ]);
    expect(parseReceivePackResponse(sidebanded)).toEqual({ ok: true, refErrors: [] });
  });
});
