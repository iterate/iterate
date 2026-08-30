// prove_disable_shadow.mjs — LIFECYCLE BUG: disableProcessor pops only the NEWEST mount off the
// shadow stack, so a processor enabled TWICE (the supported "re-enable while warm" scenario) is
// NOT disabled by one disableProcessor call — the older shadowed mount resurfaces and the
// processor keeps running (while its facet storage was just deleted → it silently re-reduces the
// whole log from offset 0).
//
// ROOT CAUSE: stream-durable-object.ts disableProcessor() → revokeCapability({ path:
// `itx.subscribers.<slug>` }) → revokeCapability picks `.sort(desc)[0]` (the single NEWEST mount)
// and revokes only it. #activeSubscriptionMounts() then re-elects the older survivor as the active
// mount → #facetEntries() still lists the slug → /state shows it enabled, the next commit
// re-materializes the facet.
//
// CONTROL (single enable → single disable) is included and MUST pass (proves the harness is sane).
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_disshadow${Date.now() % 100000}`;

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const state = async (ctx) => (await fetch(`https://${BASE}/state?ctx=${ctx}`)).json();

async function run(ctx, enableTimes) {
  console.log(`\n──────── ctx=${ctx}  (enable ×${enableTimes}, then disable ×1) ────────`);
  const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${ctx}`).get();
  const append = (...events) => itx.invokeCapability({ path: ["stream", "append"], args: events });
  const snap = () => itx.invoke("itx.facets.get('tally').snapshot()");

  for (let i = 0; i < enableTimes; i++) await itx.enableProcessor("tally");
  await append({ type: "mark" });
  const s0 = await snap();
  console.log(`  enabled: tally counts mark=${s0?.state?.counts?.mark}, offset=${s0.offset}`);

  const st0 = await state(ctx);
  const mountsForTally0 = st0.subscriptionMounts.filter((m) => m.name === "tally").length;
  console.log(
    `  /state.facetProcessors=${JSON.stringify(st0.facetProcessors)} ; tally mounts=${mountsForTally0}`,
  );

  // THE DISABLE — one call
  await itx.disableProcessor("tally");

  const st1 = await state(ctx);
  const stillListed = st1.facetProcessors.includes("tally");
  console.log(
    `  after disableProcessor("tally"): /state.facetProcessors=${JSON.stringify(st1.facetProcessors)}`,
  );

  // Does the facet still answer? A truly-disabled processor throws NO_FACET.
  let snapAfter, snapErr;
  try {
    snapAfter = await snap();
  } catch (e) {
    snapErr = String(e);
  }
  const throws = /no facet/i.test(snapErr ?? "");
  console.log(
    `  snapshot after disable: ${throws ? `THREW (${snapErr.slice(0, 60)})` : `ANSWERED ${JSON.stringify(snapAfter?.state?.counts)}`}`,
  );

  // Append once more and see whether a "disabled" processor keeps counting.
  await append({ type: "mark2" });
  await new Promise((r) => setTimeout(r, 400));
  let liveAfter, liveErr;
  try {
    liveAfter = await snap();
  } catch (e) {
    liveErr = String(e);
  }
  console.log(
    `  post-disable append → snapshot: ${liveErr ? `THREW` : `ANSWERED ${JSON.stringify(liveAfter?.state?.counts)}`}`,
  );

  return { stillListed, throws, liveAfter, liveErr };
}

// CONTROL: single enable, single disable → the processor is genuinely off.
const control = await run(`${CTX}_control`, 1);
check(
  control.stillListed === false,
  "[control] single enable→disable: /state no longer lists tally",
);
check(control.throws === true, "[control] single enable→disable: snapshot throws NO_FACET");

// THE BUG: double enable (shadow stack), single disable → the processor MUST be off.
const bug = await run(`${CTX}_bug`, 2);
check(
  bug.stillListed === false,
  "[bug] double-enable then ONE disable: /state must NOT list tally",
  bug.stillListed ? "tally STILL listed — shadowed mount resurfaced" : "",
);
check(
  bug.throws === true,
  "[bug] double-enable then ONE disable: snapshot must throw NO_FACET",
  bug.throws ? "" : "facet still answers — processor not disabled",
);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — ${
    failures === 0
      ? "no bug"
      : "disableProcessor does not remove a shadowed enablement mount (leftover processor)"
  }`,
);
process.exit(failures === 0 ? 0 : 1);
