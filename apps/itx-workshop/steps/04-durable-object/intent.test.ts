// Intent: two clients rendezvous in a Durable Object. Client A provides a LIVE
// capability; client B — a separate socket — invokes it, and A's code runs. The
// registry (and the live stub) live in the DO, not in either connection.
//
//   npm run dev
//   node --experimental-strip-types steps/04-durable-object/intent.test.ts

import { connect, sleep } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const URL = `${WS}/steps/04-durable-object`;

interface Registry {
  provideCapability(name: string, capability: any): Promise<string>;
  invoke(name: string, args: unknown[]): Promise<any>;
  list(): Promise<string[]>;
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  // Client A (the laptop): provides a live capability, then STAYS connected.
  using a = connect<Registry>(URL);
  let ranOnA = false;
  await a.provideCapability("ping", (async () => {
    ranOnA = true;
    return "pong from A";
  }) as any);
  await sleep(50);

  // Client B (the dashboard): a SEPARATE socket meeting the SAME DO.
  using b = connect<Registry>(URL);
  const names = await b.list();
  const out = await b.invoke("ping", []);
  check(
    "client B invokes the live cap client A provided (cross-client rendezvous via the DO)",
    out === "pong from A" && names.includes("ping"),
    `B saw caps=${JSON.stringify(names)}; B.invoke("ping") -> ${JSON.stringify(out)}`,
  );
  check("A's code actually ran (the live stub executed on A's connection)", ranOnA);

  console.log(`\n${failures === 0 ? "step 04 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
