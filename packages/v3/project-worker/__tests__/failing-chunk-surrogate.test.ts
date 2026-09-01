// __tests__/failing-chunk-surrogate.test.ts — BUG HUNT: chunk boundary corrupts a split
// surrogate pair. StreamEventLog.#storeEvent slices the serialized JSON *string* every
// EVENT_CHUNK_SIZE (512Ki) UTF-16 CODE UNITS and stores each slice as its own SQLite TEXT cell.
// A surrogate pair (any astral-plane char — emoji, rare CJK, math symbols) that straddles a
// boundary is split into two LONE surrogates, one per cell. Lone surrogates are not valid UTF-8,
// so the real workerd SQLite TEXT binding cannot store them faithfully. #reassemble joins the
// cells back, but the halves are already corrupted -> the round-trip is NOT byte-identical.
// prove_chunk.mjs never catches this because "y".repeat(...) is pure ASCII.

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

const EVENT_CHUNK_SIZE = 512 * 1024; // must match core/event-log.ts
const EMOJI = String.fromCodePoint(0x1f600); // "grinning face" = high+low surrogate pair

test("a surrogate pair straddling a chunk boundary round-trips byte-identically", async () => {
  // BUG: #storeEvent slices JSON by UTF-16 code-unit count; a surrogate pair split across the
  //   boundary becomes two lone surrogates in two TEXT cells, which workerd SQLite mangles.
  // EXPECTED: read() returns the exact bytes that were appended (byte-identical), emoji intact.
  // ACTUAL: the astral char that straddled the boundary comes back as U+FFFD replacement chars.
  const itx = await harness.itx("prj_chunk_surrogate");

  // Where does the blob's first char land inside the server's serialized JSON? The server
  // serializes `{ ...input, createdAt }`; createdAt is appended AFTER, so the prefix before the
  // blob content equals this sample's prefix (index of MARKER = blob[0]'s position).
  const prefixLen = JSON.stringify({ type: "big", payload: { blob: "MARKER" } }).indexOf("MARKER");
  expect(prefixLen).toBeGreaterThan(0);

  // Put the HIGH surrogate at server-JSON index EVENT_CHUNK_SIZE-1 (last unit of chunk 0) so the
  // LOW surrogate lands at index EVENT_CHUNK_SIZE (first unit of chunk 1): the pair is split.
  const highAtBlobIndex = EVENT_CHUNK_SIZE - 1 - prefixLen;
  const blob = "a".repeat(highAtBlobIndex) + EMOJI + "a".repeat(64);

  // Sanity on the local string: index highAtBlobIndex really is a high surrogate.
  const hi = blob.charCodeAt(highAtBlobIndex);
  expect(hi).toBeGreaterThanOrEqual(0xd800);
  expect(hi).toBeLessThanOrEqual(0xdbff);

  const [committed] = await itx.invokeCapability([
    "itx",
    ["append", { type: "big", payload: { blob } }],
  ]);
  // The append echo is the in-memory object — always intact; the real test is storage read-back.
  expect(committed.payload.blob).toBe(blob);

  // Read back through a FRESH session -> forces a real reassembly from event_chunks, not an echo.
  const itx2 = await harness.itx("prj_chunk_surrogate");
  const page = await itx2.invokeCapability(["itx", ["read", committed.offset - 1, 10]]);
  const back = page.events.find((e: any) => e.offset === committed.offset);
  expect(back).toBeTruthy();

  // The load-bearing assertion: byte-identical round-trip.
  const got: string = back.payload.blob;
  const window = (s: string) =>
    JSON.stringify(
      [...s.slice(highAtBlobIndex - 1, highAtBlobIndex + 2)].map((c) =>
        c.codePointAt(0)?.toString(16),
      ),
    );
  expect(
    got === blob,
    `blob NOT byte-identical. around the split boundary — expected code units ${window(blob)}, ` +
      `got ${window(got)} (U+fffd = replacement char)`,
  ).toBe(true);
});
