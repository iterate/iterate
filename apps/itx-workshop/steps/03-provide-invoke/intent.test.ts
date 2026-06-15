// Intent: a runtime capability registry. `provide` registers a capability by
// name; `invoke` calls it. On the SAME connection this works; a SECOND connection
// gets its own empty registry and can't see it — which is exactly what Step 04
// (a Durable Object) fixes.
//
//   npm run dev
//   node --experimental-strip-types steps/03-provide-invoke/intent.test.ts

import { connect } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const URL = `${WS}/steps/03-provide-invoke`;

interface Registry {
  provide(args: { name: string; capability: any }): Promise<string>;
  invoke(args: { name: string; args: unknown[] }): Promise<any>;
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  using a = connect<Registry>(URL);
  await a.provide({ name: "double", capability: (async (n: number) => n * 2) as any });
  check(
    "provide then invoke on the SAME connection",
    (await a.invoke({ name: "double", args: [21] })) === 42,
  );

  // A second connection has its own empty registry.
  using b = connect<Registry>(URL);
  let threw = "";
  try {
    await b.invoke({ name: "double", args: [1] });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    "a SECOND connection can't see it (per-connection registry → motivates Step 04)",
    /no capability/.test(threw),
    JSON.stringify(threw),
  );

  console.log(`\n${failures === 0 ? "step 03 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
