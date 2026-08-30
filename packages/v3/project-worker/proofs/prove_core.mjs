// prove_core.mjs — THE CORE PROCESSOR live: the stream's operational truth folded INLINE at
// the commit point (the apps/os shape). Control is ordinary events; enforcement is the parent
// reading the fold. Proves: pause refuses appends (control passes), resume heals, the token-
// bucket breaker trips on the (N+1)th durable append and refills by wall time, breaker-off
// restores unlimited, and /state exposes the core truth.
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_core${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
const append = (type, payload) =>
  itx.invokeCapability(
    `itx.stream.append(${JSON.stringify({ type, ...(payload ? { payload } : {}) })})`,
  );
const rejects = async (fn, re) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return re.test(String(e.message ?? e)) ? "ok" : String(e.message).slice(0, 90);
  }
};

// ── pause ──
await append("work"); // establish the stream
await append("events.iterate.com/stream/paused", { reason: "maintenance window" });
const pausedErr = await rejects(() => append("work"), /stream paused: maintenance window/);
check(
  pausedErr === "ok",
  "paused: a plain append is refused with the reason",
  pausedErr ?? "APPEND SUCCEEDED",
);
const controlOk = await append("events.iterate.com/stream/resumed").then(
  () => true,
  (e) => String(e),
);
check(
  controlOk === true,
  "control events pass through a paused stream (resume always works)",
  String(controlOk).slice(0, 80),
);
await append("work");
check(true, "resumed: plain appends flow again");

// ── circuit breaker ──
await append("events.iterate.com/stream/breaker-configured", { capacity: 3, refillPerSecond: 0.5 });
let tripped = null;
let admitted = 0;
for (let i = 0; i < 6; i++) {
  const r = await rejects(() => append("burst"), /circuit breaker open/);
  if (r === "ok") {
    tripped = i;
    break;
  }
  if (r === null) admitted++;
  else {
    tripped = `wrong error: ${r}`;
    break;
  }
}
check(
  tripped === 3 && admitted === 3,
  "breaker admits exactly its capacity (3) then trips on the 4th",
  `admitted=${admitted} trippedAt=${tripped}`,
);

// refill: 0.5 tokens/s → one token back after ~2s
await new Promise((r) => setTimeout(r, 2600));
const afterRefill = await rejects(() => append("burst"), /circuit breaker open/);
check(
  afterRefill === null,
  "the bucket refills by wall time — one more append admitted after ~2.6s",
  afterRefill ?? "",
);
const immediatelyAgain = await rejects(() => append("burst"), /circuit breaker open/);
check(
  immediatelyAgain === "ok",
  "and the very next append trips again (the refill was one token)",
  immediatelyAgain ?? "APPEND SUCCEEDED",
);

// ephemeral events are never counted (they cost no storage)
const eph = await rejects(() => append("chunk-ish"), /x/).catch(() => null); // placeholder no-op
const ephOk = await itx
  .invokeCapability(`itx.stream.append({ type: 'chunk', ephemeral: true })`)
  .then(
    () => true,
    (e) => String(e).slice(0, 80),
  );
check(
  ephOk === true,
  "ephemeral appends bypass the breaker (durable growth is what it meters)",
  String(ephOk),
);

// breaker off
await append("events.iterate.com/stream/breaker-configured", {});
for (let i = 0; i < 5; i++) await append("free");
check(true, "empty configure turns the breaker off — 5 rapid appends admitted");

// ── observability ──
const state = await fetch(`https://${BASE}/state?ctx=${CTX}`).then((r) => r.json());
check(
  state.core && state.core.paused === null && state.core.breaker === null,
  "/state exposes the core fold (unpaused, breaker off)",
  JSON.stringify(state.core),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
