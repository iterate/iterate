// prove_livestate.mjs — LIVE STATE, client-chained (the owner's simplification): each change
// event says "I am the diff relative to rev X"; the stream is a PURE FORWARDER (no per-row
// server state at all). The client does: subscribe → read the producer's door {rev, state} →
// apply payloads whose `from` matches its rev, re-read the door on any mismatch. Proves: the
// client loop converges byte-identical with the door, the steady path needs zero re-reads,
// revisions chain exactly (both flavors), out-of-order/duplicate frames are harmless, and the
// loop guard holds.
import { newWebSocketRpcSession } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_live${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const until = async (label, fn, timeoutMs = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: timed out`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

// the client half of the wire: apply an RFC 6902-subset patch (mirrors core/patch.ts applyPatch)
const applyPatch = (doc, ops) => {
  let root = structuredClone(doc);
  for (const op of ops) {
    if (op.path === "") {
      root = op.value;
      continue;
    }
    const segs = op.path
      .slice(1)
      .split("/")
      .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
    const last = segs.pop();
    let parent = root;
    for (const s of segs) parent = Array.isArray(parent) ? parent[Number(s)] : parent[s];
    if (Array.isArray(parent)) {
      if (op.op === "add")
        last === "-" ? parent.push(op.value) : parent.splice(Number(last), 0, op.value);
      else if (op.op === "replace") parent[Number(last)] = op.value;
      else parent.splice(Number(last), 1);
    } else if (op.op === "remove") delete parent[last];
    else parent[last] = op.value;
  }
  return root;
};

// THE WHOLE CLIENT (this is the documented loop): buffer payloads from subscribe time, seed
// through the door, then: to <= rev → duplicate, drop; from === rev → apply; else → re-read.
const liveClient = (readDoor) => {
  const c = {
    doc: undefined,
    rev: null,
    applied: 0,
    dropped: 0,
    reseeds: 0,
    queue: [],
    frames: [],
    seeded: false,
  };
  const pump = async () => {
    while (c.queue.length) {
      const u = c.queue.shift();
      if (u.to <= c.rev) c.dropped++;
      else if (u.from === c.rev) {
        c.doc = applyPatch(c.doc, u.patch);
        c.rev = u.to;
        c.applied++;
      } else {
        c.reseeds++;
        ({ rev: c.rev, state: c.doc } = await readDoor());
      }
    }
  };
  c.consume = (u) => {
    c.frames.push(u);
    c.queue.push(u);
    if (c.seeded) void pump();
  };
  c.seed = async () => {
    ({ rev: c.rev, state: c.doc } = await readDoor());
    c.seeded = true;
    await pump();
  };
  return c;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
await seedSources(itx, ["chatroom", "chunky"]);

// ── mini-app flavor: the chatroom (SDK liveState helper) ──
await itx.provide({
  path: "itx.chat",
  target: `itx.load("itx.kv.get('src/chatroom.js')").getDurableObjectClass('Chatroom').get()`,
});

const chat = liveClient(async () =>
  JSON.parse(JSON.stringify(await itx.invoke("itx.chat.state()"))),
);
await itx.subscribe({
  name: "chatwatch",
  liveState: { key: "chat" },
  target: (u) => chat.consume(JSON.parse(JSON.stringify(u))),
});
await chat.seed();
const chatSeedRev = chat.rev; // an incarnation EPOCH, not 0 — reborn holders must never re-use old rev numbers
check(
  typeof chatSeedRev === "number" && chat.doc.messages.length === 0,
  "client seeded itself through the door ({rev: epoch, empty room})",
  JSON.stringify({ rev: chatSeedRev, doc: chat.doc }),
);

await itx.invokeCapability({ path: ["chat", "post"], args: ["jonas", "hi"] });
await itx.invokeCapability({ path: ["chat", "post"], args: ["jonas", "again"] });
await until("two messages", () => chat.doc?.messages?.length === 2);
check(
  chat.applied === 2 && chat.reseeds === 0,
  "steady path: two patches applied, ZERO re-reads",
  `applied=${chat.applied} reseeds=${chat.reseeds}`,
);
check(
  chat.rev === chatSeedRev + 2,
  "client rev chained epoch→+1→+2",
  `rev=${chat.rev - chatSeedRev} above epoch`,
);
check(
  chat.doc.messages[1].text === "again",
  "applyPatch converged on the server value",
  JSON.stringify(chat.doc.messages),
);
const door = JSON.parse(JSON.stringify(await itx.invoke("itx.chat.state()")));
check(
  door.rev === chat.rev && JSON.stringify(door.state) === JSON.stringify(chat.doc),
  "door and patched client doc are byte-identical",
  JSON.stringify(door).slice(0, 110),
);

// out-of-order / duplicate frames are harmless: replay an old payload, then a gapped one
chat.consume(JSON.parse(JSON.stringify(chat.frames.find((f) => f.from !== undefined)))); // replay a real old frame verbatim
await until("dup dropped", () => chat.dropped >= 1);
check(
  chat.doc.messages.length === 2,
  "a late/duplicate frame is dropped by rev, not applied",
  `dropped=${chat.dropped}`,
);
chat.consume({ key: "chat", from: chat.rev + 5, to: chat.rev + 6, patch: [] });
await until("gap healed", () => chat.reseeds >= 1);
check(
  JSON.stringify(chat.doc) === JSON.stringify(door.state) && chat.rev === chatSeedRev + 2,
  "a gapped frame triggers one door re-read and converges",
  `reseeds=${chat.reseeds}`,
);

// ── processor flavor: chunky's fold, door = liveSnapshot() ──
await itx.enableProcessor("chunky", { source: "itx.kv.get('src/chunky.js')", className: "Chunky" });
const proc = liveClient(async () =>
  JSON.parse(JSON.stringify(await itx.invoke("itx.facets.get('chunky').liveSnapshot()"))),
);
await itx.subscribe({
  name: "chunkywatch",
  liveState: { key: "chunky" },
  target: (u) => proc.consume(JSON.parse(JSON.stringify(u))),
});
await proc.seed();
const seedRev = proc.rev;
check(
  typeof seedRev === "number" && proc.doc.marks === 0,
  "processor door seeded {rev, projection}",
  JSON.stringify({ rev: seedRev, doc: proc.doc }),
);

await itx.invoke(`itx.stream.append({ type: 'mark' })`);
await until("mark folded", () => proc.doc?.marks >= 1);
await itx.invoke(`itx.stream.append({ type: 'mark' })`);
await until("second mark", () => proc.doc?.marks >= 2);
check(
  proc.applied === 2 && proc.reseeds === 0,
  "processor patches chained from the seed rev, zero re-reads",
  `applied=${proc.applied} reseeds=${proc.reseeds} rev=${seedRev}→${proc.rev}`,
);
check(
  proc.doc.marks === 2 && proc.doc.chunks === 0,
  "patched client doc matches the projection",
  JSON.stringify(proc.doc),
);

// ── the loop guard: nothing consumed the change events ──
const snap = await itx.invoke("itx.facets.get('chunky').snapshot()");
check(
  !JSON.stringify(snap).includes("live-state"),
  "live-state change events are unconsumable (no loop)",
  "",
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
