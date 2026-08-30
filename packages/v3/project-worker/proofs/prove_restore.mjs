// prove_restore.mjs — Kenton's persistent-stub machinery IN USE: a userspace durable object
// stores its live capability handle (the ctx.exports-minted IterateContextEntrypoint stub) in
// its OWN storage, then uses the handle read back from storage — which replays the restore
// chain on use. storage.put would THROW for any non-restorable stub, so put succeeding + the
// restored call answering IS the proof the machinery accepted and replayed it.
import { newWebSocketRpcSession } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_rest${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
await seedSources(itx, ["keeper"]);

await itx.provide({
  path: "itx.keeper",
  target: `itx.load("itx.kv.get('src/keeper.js')").getDurableObjectClass('Keeper').get()`,
});

// 1. stash: storage.put(env.ITX) — throws unless the whole chain is restore-eligible
const stashed = await itx.invokeCapability({ path: ["keeper", "stash"], args: [] });
check(
  stashed?.stashed === true,
  "storage.put accepted the live capability handle",
  JSON.stringify(stashed),
);

// 2. use the RESTORED handle (storage.get replays the restore chain on use)
const who = await itx.invokeCapability({ path: ["keeper", "useStashed"], args: [] });
check(
  who?.projectId === CTX,
  "restored handle answers whoami through the routed table",
  JSON.stringify(who),
);

// 3. and again — replay is per-load, not a one-shot
const who2 = await itx.invokeCapability({ path: ["keeper", "useStashed"], args: [] });
check(who2?.projectId === CTX, "second load replays again", JSON.stringify(who2));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
