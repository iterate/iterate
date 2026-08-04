// Run the design in REAL workerd (via Miniflare) and prove three transports:
//   1. Node client → workerd capnweb server           (/api over a real WebSocket)
//   2. gateway isolate → DO isolate, NATIVE Workers RPC (/test/native — the brand-check leg)
//   3. workerd client → workerd capnweb server         (/test/capnweb — gateway → peer)
//
// Build the bundles first (build.mjs), then boot Miniflare with two workers + a DO.

import { Miniflare } from "miniflare";
import { newWebSocketRpcSession } from "capnweb";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runDemo, checkDemo } from "./graph.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const results = [];
const record = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`\n### ${label}\n  ${ok ? "✅ PASS" : "❌ FAIL"}  ${detail ?? ""}`);
};

const mf = new Miniflare({
  workers: [
    {
      name: "gateway",
      modules: true,
      scriptPath: resolve(here, ".built/gateway.js"),
      compatibilityDate: "2026-07-01",
      durableObjects: { HOST_DO: "HostDO" },
      serviceBindings: { SELF: "gateway", PEER: "peer" },
    },
    {
      name: "peer",
      modules: true,
      scriptPath: resolve(here, ".built/peer.js"),
      compatibilityDate: "2026-07-01",
    },
  ],
});

const base = await mf.ready; // URL of the entry worker (gateway)
console.log(`Miniflare up at ${base.origin}`);

// ── 1. Node client → workerd capnweb server (real WebSocket) ────────────────────
try {
  const wsUrl = new URL("/api", base);
  wsUrl.protocol = "ws:";
  const project = newWebSocketRpcSession(wsUrl.toString()); // returns the remote-main stub directly
  const r = await runDemo(project);
  const problems = checkDemo(r);
  record(
    "1. Node client → workerd capnweb server (/api)",
    problems.length === 0,
    problems.length
      ? problems.join("; ")
      : `flavor+egress+shadow all correct; egress body: ${JSON.stringify(r.egress.body)}`,
  );
  project[Symbol.dispose]?.();
} catch (e) {
  record("1. Node client → workerd capnweb server (/api)", false, String(e?.stack || e));
}

// ── 2. Native Workers-RPC boundary (gateway → DO) ───────────────────────────────
try {
  const res = await mf.dispatchFetch("http://gateway/test/native");
  const j = await res.json();
  record(
    "2. NATIVE Workers RPC across a DO boundary (/test/native)",
    j.ok === true,
    j.ok ? `${j.transport}; pipelined through the returned host` : JSON.stringify(j.problems || j),
  );
} catch (e) {
  record("2. NATIVE Workers RPC across a DO boundary (/test/native)", false, String(e?.stack || e));
}

// ── 3. workerd client → workerd capnweb server (gateway → peer) ─────────────────
try {
  const res = await mf.dispatchFetch("http://gateway/test/capnweb");
  const j = await res.json();
  record(
    "3. workerd → workerd capnweb (/test/capnweb)",
    j.ok === true,
    j.ok ? j.transport : JSON.stringify(j.problems || j.error || j),
  );
} catch (e) {
  record("3. workerd → workerd capnweb (/test/capnweb)", false, String(e?.stack || e));
}

await mf.dispose();

console.log("\n" + "=".repeat(64));
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.label}`);
console.log(
  failed.length
    ? `\n❌ ${failed.length} FAILED`
    : "\n✅ ALL PASS in real workerd — capnweb + native RPC both pipeline through the fallthrough",
);
process.exit(failed.length ? 1 : 0);
