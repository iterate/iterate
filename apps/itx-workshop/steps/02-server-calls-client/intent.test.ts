// Intent: the client hands the server a live capability, and the SERVER calls it
// back over the same socket — code running on the client, invoked from the server.
//
//   npm run dev
//   node --experimental-strip-types steps/02-server-calls-client/intent.test.ts

import { connect } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");

interface RegisterServer {
  register(laptop: { compute: (a: number, b: number) => Promise<number> }): Promise<string>;
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  let ranOnClient = false;
  using server = connect<RegisterServer>(`${WS}/steps/02-server-calls-client`);
  const out = await server.register({
    compute: async (a: number, b: number) => {
      ranOnClient = true; // proves this executed HERE, called from the server
      return a * b;
    },
  });
  check("the server called back the client's capability", out === "the laptop computed: 42", out);
  check("the client's code actually ran (called from the server)", ranOnClient);

  console.log(`\n${failures === 0 ? "step 02 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
