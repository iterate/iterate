// Intent: a context is a durable event log folded by the real
// @iterate-com/streams StreamProcessor, and the stream DELIVERS appended events
// to the processor automatically (via its subscription) — not only the
// processor's own provides.
//
// Implementation lives in the shared core: ItxDO (../../server.ts) hosts
// `Itx extends StreamProcessor` (../../itx-processor.ts) via createStreamProcessorHost,
// backed by the real Stream DO, and configures a subscription-configured event so
// the stream pumps batches into the processor.
//
//   npm run dev
//   node --experimental-strip-types steps/07-streamprocessor/intent.test.ts

import { withItx } from "../../client.ts";

const BASE = process.env.ITX_BASE ?? "http://127.0.0.1:8787";
const CTX = `step07-${Date.now()}`;
const open = () => withItx<any>({ baseUrl: BASE, context: CTX });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  using itx = open();

  // Baseline: provide folds into the table and is immediately invokable
  // (read-your-writes through the processor).
  await itx.provideCapability(["greeter"], async (n: string) => `hi ${n}`);
  check(
    "provide → fold → invoke (read-your-writes)",
    (await itx.invoke(["greeter"], ["ada"])) === "hi ada",
  );

  // THE POINT of this step: write an event STRAIGHT to the durable log, bypassing
  // the processor entirely. It must reach the fold via the stream's subscription
  // delivery — proving the stream pushes batches into the processor automatically.
  await itx.appendToStream({
    type: "events.iterate.com/itx/capability-provided",
    payload: {
      path: ["external"],
      kind: "rpc",
      address: { type: "rpc", note: "written externally" },
    },
  });

  let deliveredAfterMs = -1;
  for (let i = 0; i < 60; i++) {
    if ((await itx.list()).includes("external")) {
      deliveredAfterMs = i * 100;
      break;
    }
    await sleep(100);
  }
  check(
    "an external append reaches the fold via SUBSCRIPTION delivery (no provide, no self-ingest)",
    deliveredAfterMs >= 0,
    deliveredAfterMs >= 0 ? `delivered within ~${deliveredAfterMs}ms` : "not delivered within 6s",
  );

  console.log(`\n${failures === 0 ? "step 07 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
