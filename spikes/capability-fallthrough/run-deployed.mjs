// Run the same three transports against the DEPLOYED workers on the POC account
// (real internet, real workerd). BASE defaults to the deployed gateway.

import { newWebSocketRpcSession } from "capnweb";
import { runDemo, checkDemo } from "./graph.mjs";

const BASE = process.env.BASE || "https://capnweb-spike-gateway.iterate.workers.dev";
const results = [];
const record = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`\n### ${label}\n  ${ok ? "✅ PASS" : "❌ FAIL"}  ${detail ?? ""}`);
};

// 1. Node client → DEPLOYED workerd capnweb server, over wss on the public internet.
try {
  const wsUrl = BASE.replace(/^http/, "ws") + "/api";
  const project = newWebSocketRpcSession(wsUrl);
  const r = await runDemo(project);
  const problems = checkDemo(r);
  record(
    "1. Node client → DEPLOYED workerd capnweb server (wss /api)",
    problems.length === 0,
    problems.length ? problems.join("; ") : `egress body: ${JSON.stringify(r.egress.body)}`,
  );
  project[Symbol.dispose]?.();
} catch (e) {
  record(
    "1. Node client → DEPLOYED workerd capnweb server (wss /api)",
    false,
    String(e?.stack || e),
  );
}

// 2. NATIVE Workers RPC across a DO boundary, on the deployed worker.
try {
  const j = await (await fetch(`${BASE}/test/native`)).json();
  record(
    "2. DEPLOYED native Workers RPC across a DO boundary (/test/native)",
    j.ok === true,
    j.ok ? j.transport : JSON.stringify(j.problems || j),
  );
} catch (e) {
  record(
    "2. DEPLOYED native Workers RPC across a DO boundary (/test/native)",
    false,
    String(e?.stack || e),
  );
}

// 3. workerd → workerd capnweb across a service binding, both deployed.
try {
  const j = await (await fetch(`${BASE}/test/capnweb`)).json();
  record(
    "3. DEPLOYED workerd → workerd capnweb (/test/capnweb)",
    j.ok === true,
    j.ok ? j.transport : JSON.stringify(j.problems || j.error || j),
  );
} catch (e) {
  record("3. DEPLOYED workerd → workerd capnweb (/test/capnweb)", false, String(e?.stack || e));
}

console.log("\n" + "=".repeat(64));
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.label}`);
console.log(
  failed.length
    ? `\n❌ ${failed.length} FAILED`
    : `\n✅ ALL PASS on the DEPLOYED POC workers (${BASE})`,
);
process.exit(failed.length ? 1 : 0);
