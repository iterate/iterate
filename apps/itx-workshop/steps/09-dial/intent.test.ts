// Intent: a sturdy capability is plain data — a ref naming a worker to build and
// run. `dial` turns it back into something callable by LOADING the worker (the
// Worker Loader) and handing back its entrypoint; the entrypoint's methods run
// in the freshly-built isolate, with the ref's `props` arriving as ctx.props.
//
//   npm run dev
//   node --experimental-strip-types steps/09-dial/intent.test.ts

import { withItx } from "../../client.ts";

const BASE = process.env.ITX_BASE ?? "http://127.0.0.1:8787";
const CTX = `step09-${Date.now()}`;
const open = () => withItx<any>({ baseUrl: BASE, context: CTX });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The capability's CODE — a real WorkerEntrypoint module, as source. dial builds
// a worker from this and runs it; `this.ctx.props` is whatever the ref carried.
const CALC_SOURCE = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export class Calc extends WorkerEntrypoint {
    add(a, b) { return (this.ctx.props?.base ?? 0) + a + b; }
    base() { return this.ctx.props?.base ?? 0; }
  }
`;

async function main() {
  using itx = open();

  // Provide a STURDY capability: not a live stub, just a serializable ref.
  await itx.provideCapability(["calc"], {
    type: "rpc",
    worker: { type: "source", source: CALC_SOURCE },
    entrypoint: "Calc",
    props: { base: 100 },
  });

  // Invoking it dials the ref → builds + runs the worker → calls the method.
  const sum = await itx.invoke(["calc", "add"], [2, 3]);
  check(
    "dial built + ran a worker from source; props applied",
    sum === 105,
    `calc.add(2,3) with props.base=100 -> ${sum} (computed inside the loaded isolate)`,
  );

  const base = await itx.invoke(["calc", "base"], []);
  check(
    "a second method on the dialed entrypoint (cached isolate)",
    base === 100,
    `calc.base() -> ${base}`,
  );

  console.log(`\n${failures === 0 ? "step 09 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
