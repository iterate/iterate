// Intent: a client opens a socket to the server, calls a method on the typed
// stub, and gets the result back — and `using` disposes the session (closing the
// socket) at scope end. That is the whole primitive this step exists to show.
//
//   npm run dev                                    # terminal 1 (wrangler)
//   node --experimental-strip-types steps/01-socket/intent.test.ts   # terminal 2

import { connect } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const URL = `${WS}/steps/01-socket`;

interface Server {
  whoami(): Promise<string>;
  greet(person: string): Promise<string>;
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  {
    using itx = connect<Server>(URL);
    check(
      "itx.whoami() runs on the server, returns over the socket",
      (await itx.whoami()) === "the itx server",
    );
    check("itx.greet('ada') passes an argument across", (await itx.greet("ada")) === "hello, ada");
  } // `using` disposed the session here — no error means the socket closed cleanly.
  check("`using` disposal left scope without throwing", true);

  console.log(`\n${failures === 0 ? "step 01 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
