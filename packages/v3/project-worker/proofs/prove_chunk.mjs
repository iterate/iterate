// prove_chunk.mjs — row chunking LIVE: a >2MB body commits, round-trips byte-identically through
// the real DO SQLite (event_chunks), keeps offsets dense, and dedupes an idempotent chunked retry.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = `prj_chunklive${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const append = (itx, events) => itx.invokeCapability({ path: ["stream", "append"], args: events });
const read = (itx, after, limit) =>
  itx.invokeCapability({ path: ["stream", "read"], args: [after, limit] });

const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();

// A small event, then a 5MB body, then a small event — dense offsets on both sides.
const [before] = await append(itx, [{ type: "small-before" }]);
const blob = "y".repeat(5 * 1024 * 1024);
const big = await append(itx, [{ type: "big", payload: { blob } }]);
const [after] = await append(itx, [{ type: "small-after" }]);
check(big.length === 1, "5MB body committed as ONE event (not split)", `${big.length}`);
check(big[0].offset === before.offset + 1, "chunked event is dense with its predecessor");
check(after.offset === big[0].offset + 1, "and dense with its successor");

// Read it back through a FRESH session — a real storage reassembly, not an echo.
const itx2 = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();
const page = await read(itx2, before.offset, 500);
const back = page.events.find((e) => e.offset === big[0].offset);
check(back?.type === "big", "5MB event reads back", back?.type);
check(
  back?.payload?.blob === blob,
  "5MB body round-trips BYTE-IDENTICALLY",
  `len ${back?.payload?.blob?.length}`,
);
check(
  page.events.map((e) => e.type).join(",") === "big,small-after",
  "chunk rows invisible to paging (dense event list)",
  page.events.map((e) => e.type).join(","),
);

// An idempotent RETRY of a large chunked payload dedupes to the same offset.
const keyed = { type: "big-keyed", payload: { blob }, idempotencyKey: "chunk-once" };
const [k1] = await append(itx, [keyed]);
const [k2] = await append(itx, [keyed]);
check(
  k2.offset === k1.offset,
  "chunked idempotent retry dedupes to the same offset",
  `${k1.offset}==${k2.offset}`,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
