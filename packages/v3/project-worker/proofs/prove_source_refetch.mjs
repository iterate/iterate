// prove_source_refetch.mjs — HOT-PATH FIX, live: a USERSPACE (ref-carrying) processor resolves its
// source expression exactly ONCE per materialization — NOT on every commit.
//
// THE FIX (agent-C): the commit pump (stream-durable-object.ts `#driveFacets`) calls
// `this.#facet(slug)` per commit → `#durableFacet` → worker-loader.ts `loadConfinedWorker`. That
// used to `resolveSource(...)` (`await invoke(toExpression(source))` — a code fetch) + `hashSource`
// on EVERY commit, to compute the contentHash. Now `#durableFacet` keeps a per-facet
// `#resolvedFacetSource` memo keyed by the PRINTED source expression: on a warm facet it passes the
// cached `{ modules, version }` straight through, skipping the fetch+hash. The memo is dropped on
// disable and cleared at idle-quiesce, so a source EDIT is picked up at the next materialization
// (never mid-incarnation per-commit — which the deploy-keyed loader was never meant to do).
// Built-ins already had this shape (a CLASS handed to `ctx.facets.get(name, () => ({class}))`); this
// brings userspace processors to parity: M commits add ZERO source re-evaluations.
//
// HOW WE COUNT: the processor's SOURCE is an itx-expression that, when evaluated, bumps a KV
// counter `srcEvals` and returns the (kv-seeded) processor module code. A KV bump — NOT a stream
// append — so evaluating the source has an observable, NON-re-entrant side effect (an append here
// would re-trigger the pump → infinite loop). `srcEvals` == number of source evaluations.
//
// THE READ-PATH CAVEAT (kept honest): reading `itx.facets.get(slug).snapshot()` ALSO routes
// through `#addressNamed` → `#facet(slug)` → `resolveSource`, so a snapshot read would ALSO bump
// the counter. We therefore never poll the snapshot while measuring; we poll `itx.kv.get('srcEvals')`
// (which does NOT touch the facet) until it settles, isolating the count to the COMMIT path.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = `prj_srcrefetch${Date.now() % 100000}`;
const SLUG = "mark-refetch";
const M = 5; // durable 'mark' commits after warm-up

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// A TINY StreamProcessor module — seeded into kv so the source lambda merely READS it back (no
// nested module-string escaping). The runner imports `* as a from "./cap.js"` and picks a[className].
const MARK_MODULE = `import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "${SLUG}",
  version: "1.0.0",
  description: "Counts committed marks — source-refetch proof.",
  stateSchema: z.object({ marks: z.number().default(0) }),
  events: {},
  consumes: ["mark"],
  emits: [],
});
export class Mark extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    if (event.type === "mark") return { marks: state.marks + 1 };
  }
}`;

// The SOURCE expression: evaluating it bumps srcEvals (observable, non-re-entrant) and returns the
// module code. Simple single-quoted body → JSON.stringify handles all escaping; the expression
// parser JSON5-parses the arg and its matchingParen skips the quoted string (see core/expression.ts).
const LAMBDA =
  "async (itx) => { const n = Number((await itx.kv.get('srcEvals')) ?? 0) + 1; await itx.kv.put('srcEvals', String(n)); return await itx.kv.get('src/mark-refetch.js'); }";
const SOURCE = `itx.runScript(${JSON.stringify(LAMBDA)})`;

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.get();

const kvGetNum = async (k) => Number((await itx.invokeCapability(["itx", "kv", ["get", k]])) ?? 0);
const append = (events) => itx.invokeCapability(["itx", "stream", ["append", ...events]]);

// Settle detector that NEVER touches the facet: poll the kv counter until it stops climbing.
async function settledSrcEvals() {
  let last = -1;
  let stableFor = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const n = await kvGetNum("srcEvals");
    if (n === last) {
      if (++stableFor >= 3) return n; // 3 consecutive equal reads (~1.5s quiet) = drives settled
    } else {
      stableFor = 0;
      last = n;
    }
  }
  return last;
}

// 1) seed the module code into kv (the lambda reads it back on each evaluation)
await itx.invokeCapability(["itx", "kv", ["put", "src/mark-refetch.js", MARK_MODULE]]);

// 2) enable the USERSPACE processor (source = the counting expression)
await itx.enableProcessor(SLUG, { source: SOURCE, className: "Mark" });

// 3) let the enablement's own drives (mount commit + warm-up) settle, then take the baseline
const beforeMarks = await settledSrcEvals();
console.log(`\nsrcEvals after enable (materialization + enablement mount drive): ${beforeMarks}`);

// 4) append M durable 'mark' events — M separate commits, each a pump run
let head = 0;
for (let i = 0; i < M; i++) {
  const [ev] = await append([{ type: "mark", payload: { i } }]);
  head = ev.offset;
}
console.log(`appended ${M} durable marks; head offset = ${head}`);

// 5) wait for the M fire-and-forget drives to settle (counter-stability, NOT snapshot polling)
const afterMarks = await settledSrcEvals();
const perCommit = afterMarks - beforeMarks;

console.log(`\n──────────── RESULT ────────────`);
console.log(`M (durable commits after warm-up)      : ${M}`);
console.log(
  `srcEvals total                          : ${afterMarks}   (expected 1 if source is fetched ONCE)`,
);
console.log(
  `srcEvals attributable to the M commits  : ${perCommit}   (expected 0 for a warm facet)`,
);
console.log(`────────────────────────────────\n`);

// PRIMARY assertion — RED on purpose: a warm userspace facet should evaluate its source ONCE
// (at materialization), so the total should be 1. It is ~M+ because `resolveSource` runs inside
// `#durableFacet` on EVERY `#facet(slug)` call the commit pump makes.
check(
  afterMarks === 1,
  "userspace processor source is evaluated exactly ONCE (fetched at materialization, not per commit)",
  `srcEvals=${afterMarks}`,
);

// Corroborating: the M mark commits should add ZERO source evaluations to a warm facet.
check(
  perCommit === 0,
  "M warm-facet commits add ZERO source re-evaluations",
  `${perCommit} added by ${M} commits`,
);

if (failures > 0) {
  console.log(
    `\nREGRESSION: ${afterMarks} source evaluations for what should be 1 — the #resolvedFacetSource ` +
      `memo in #durableFacet is meant to skip resolveSource()+hashSource on a warm facet (keyed by ` +
      `the printed source expression, invalidated at disable/quiesce).`,
  );
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
