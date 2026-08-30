// prove_connect.mjs — itx.connectToCapnweb(url): dial a REMOTE capnweb API and call it (the
// replacement for the removed itx.os). The remote is proofs/dummy-capnweb (a public capnweb worker).
import { newWebSocketRpcSession } from "capnweb";

const BASE = "project-worker.iterate.workers.dev";
const REMOTE = "https://dummy-capnweb.iterate.workers.dev/api";
const CTX = process.env.CTX ?? `prj_connect${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const itx = await newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`).authenticate().get();

// 1. dial the remote capnweb API and call a method (one HTTP batch, no persistent socket)
const greeting = await itx.invoke(`itx.connectToCapnweb('${REMOTE}').hello('world')`);
check(
  greeting === "hi world from dummy-capnweb",
  "connectToCapnweb(url).hello('world')",
  String(greeting),
);

// 2. a second method with numeric args
const sum = await itx.invoke(`itx.connectToCapnweb('${REMOTE}').add(2, 40)`);
check(sum === 42, "connectToCapnweb(url).add(2, 40)", String(sum));

// 3. NAMED as a mount — this is exactly how `itx.os` becomes sugar over connectToCapnweb.
await itx.provide({ path: "itx.remoteApi", target: `itx.connectToCapnweb('${REMOTE}')` });
const viaMount = await itx.invoke("itx.remoteApi.hello('mounted')");
check(
  viaMount === "hi mounted from dummy-capnweb",
  "mounted alias over connectToCapnweb",
  String(viaMount),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
