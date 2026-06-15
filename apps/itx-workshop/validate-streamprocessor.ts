// validate-streamprocessor.ts — proves Step 8/11 for REAL, in-process, against
// the actual @iterate-com/streams StreamProcessor + our itx contract.
//
//   node --experimental-strip-types validate-streamprocessor.ts
//
// What it proves: provide appends an event the fold projects into the table;
// invoke resolves over the fold; longest-prefix deep shadow; revoke; and — the
// Step 8 punchline — REPLAYING the durable event log into a fresh processor
// rebuilds the identical capability table (the fold is the source of truth, not
// a mutated registry). Root capabilities are JUST provided, not built in.

import { Itx } from "./itx-processor.ts";

// A stand-in for the durable event log: the real Stream DO persists events in
// SQLite and hands them back; here an in-memory array plays that role so the
// proof runs in pure Node. The PROCESSOR is the real class.
function memoryStream() {
  let offset = 0;
  const committed: any[] = [];
  const append = ({ event }: { event: any }) => {
    const e = { ...event, offset: ++offset, createdAt: new Date(0).toISOString() };
    committed.push(e);
    return e;
  };
  return {
    stream: {
      append,
      appendBatch: ({ events }: { events: any[] }) => events.map((event) => append({ event })),
    },
    committed,
  };
}

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) fails++;
};

const { stream, committed } = memoryStream();
const itx = new Itx({ iterateContext: { stream } });

// A ROOT capability (egress) — provided with the same verb as everything else.
const fetchLog: string[] = [];
await itx.provideCapability({
  path: ["fetch"],
  capability: async (url: string) => {
    fetchLog.push(url);
    return `fetched ${url}`;
  },
});
// A live SDK-shaped object mounted as one capability.
await itx.provideCapability({
  path: ["slack"],
  capability: {
    chat: { postMessage: async (m: any) => ({ ok: true, text: m.text, via: "original" }) },
    users: { list: async () => ({ ok: true, members: ["U1", "U2"] }) },
  },
});

check(
  "provide folds into state.capabilities (the table is the fold)",
  !!itx.state.capabilities["fetch"] && !!itx.state.capabilities["slack"],
  `caps = ${JSON.stringify(Object.keys(itx.state.capabilities))}`,
);
check(
  "invoke a ROOT cap that was just provided (no built-in handle)",
  (await itx.invoke({ path: ["fetch"], args: ["/health"] })) === "fetched /health",
);
const pm = await itx.invoke({ path: ["slack", "chat", "postMessage"], args: [{ text: "hi" }] });
check("invoke a deep path on a live cap", pm.ok && pm.text === "hi" && pm.via === "original");

// longest-prefix deep shadow
await itx.provideCapability({
  path: ["slack", "chat", "postMessage"],
  capability: async (m: any) => ({ ok: true, text: m.text, via: "SHADOW" }),
});
const shadowed = await itx.invoke({
  path: ["slack", "chat", "postMessage"],
  args: [{ text: "x" }],
});
const fellThrough = await itx.invoke({ path: ["slack", "users", "list"], args: [] });
check(
  "longest-prefix deep shadow wins; siblings fall through",
  shadowed.via === "SHADOW" && fellThrough.via === undefined && fellThrough.ok,
);

// revoke removes the shadow (exact path), so the broad mount answers again
await itx.revokeCapability({ path: ["slack", "chat", "postMessage"] });
const afterRevoke = await itx.invoke({
  path: ["slack", "chat", "postMessage"],
  args: [{ text: "y" }],
});
check("revoke removes the entry; the base mount answers again", afterRevoke.via === "original");

// THE PUNCHLINE: a fresh processor replaying the SAME durable log rebuilds the
// identical capability table — the fold is the source of truth. (Live STUBS are
// not durable, so they're gone on replay; the durable TABLE is reproduced
// exactly — that's the live-vs-sturdy distinction made concrete.)
const replayItx = new Itx({ iterateContext: { stream: memoryStream().stream } });
await replayItx.ingest({ events: committed, streamMaxOffset: committed.at(-1).offset });
check(
  "replay rebuilds the table from the durable log (fold is the source of truth)",
  JSON.stringify(replayItx.state.capabilities) === JSON.stringify(itx.state.capabilities),
  `${committed.length} events folded -> ${Object.keys(replayItx.state.capabilities).length} caps`,
);
check(
  "checkpoint advanced to the log head",
  replayItx.checkpointOffset === committed.at(-1).offset,
  `checkpointOffset = ${replayItx.checkpointOffset}`,
);

console.log(
  `\n${fails === 0 ? "ALL STREAMPROCESSOR CHECKS VALID (Itx is a real StreamProcessor)" : `${fails} FAILED`}`,
);
process.exit(fails === 0 ? 0 : 1);
