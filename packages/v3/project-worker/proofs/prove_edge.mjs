// prove_edge.mjs — the edge-adoption batch: one-shot HTTP batch at /api (no WebSocket),
// fetchCap through the session (the commissioned fork feature), disableProcessor, the repo.
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_edge${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// 1. ONE-SHOT HTTP BATCH: a CLI-shaped client — no WebSocket anywhere
const batch = newHttpBatchRpcSession(`https://${BASE}/api?ctx=${CTX}`);
const who = await batch
  .authenticate()
  .get()
  .invokeCapability({ path: ["whoami"], args: [] });
check(who?.projectId === CTX, "one-shot HTTP batch: whoami without a socket", JSON.stringify(who));

// live session for the rest
const session = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itx = await session.authenticate().get();
await seedSources(itx, ["site"]);

// 2. SOURCE IS PLAIN KV (the files/repo roots died in increment 57): put source, run it
await itx.invokeCapability({
  path: ["kv", "put"],
  args: [
    "src/mine.js",
    `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Mine extends WorkerEntrypoint {
  async run() {
    const itx = await this.env.ITX.get();
    return \`from-kv:\${(await itx.whoami()).projectId}\`;
  }
}`,
  ],
});
const out = await itx.invoke(`itx.load("itx.kv.get('src/mine.js')").getEntrypoint().run()`);
check(
  out === `from-kv:${CTX}`,
  "kv-stored source runs as a worker (itx round-trip inside)",
  String(out),
);

// 3. fetchCap: a fetch-shaped capability through the SESSION (no /cap door)
await itx.provide({
  path: "itx.site",
  target: `itx.load("itx.kv.get('src/site.js')").getEntrypoint()`,
});
const resp = await itx.fetchCap("itx.site", new Request(`https://${BASE}/`));
const html = await resp.text();
check(
  resp.status === 200 && html.includes("dynamic web capability"),
  "fetchCap carries the Response over capnweb",
  `${resp.status}`,
);

// 4. disableProcessor: enable, disable, snapshot now refuses
await itx.enableProcessor("tally");
await itx.invoke(`itx.stream.append({ type: 'mark' })`);
await itx.disableProcessor("tally");
let denied = "";
try {
  await itx.invoke("itx.facets.get('tally').snapshot()");
} catch (e) {
  denied = String(e);
}
check(
  /no facet/.test(denied),
  "disabled processor is gone (row + facet deleted)",
  denied.slice(0, 60),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
