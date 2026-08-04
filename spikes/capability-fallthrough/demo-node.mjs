// Node sanity: prove the fallthrough design works (a) fully in-process, and (b) with
// the project's PARENT as a remote capnweb stub — cross-isolate fallthrough over a real
// capnweb session (the instrumented in-memory transport from spike 1).

import { RpcSession } from "capnweb";
import { makeLinkedPair } from "./inproc.mjs";
import { CapabilityHost } from "./capability-host.mjs";
import { buildGraph, runDemo, checkDemo } from "./graph.mjs";

let failed = 0;
function report(label, r, problems) {
  console.log(`\n### ${label}`);
  console.log(`  flavorPrompt : ${JSON.stringify(r.flavorPrompt)}`);
  console.log(`  brandName    : ${JSON.stringify(r.brandName)}  (static capability)`);
  console.log(`  egress       : ${JSON.stringify(r.egress)}`);
  console.log(`  shadowed     : ${JSON.stringify(r.shadowedEgress)}`);
  if (problems.length) {
    console.log(`  ❌ ${problems.join("; ")}`);
    failed++;
  } else {
    console.log(`  ✅ fallthrough + mount + egress + shadowing all correct`);
  }
}

// A) everything local — project.parent is the control-plane object.
{
  const { project } = buildGraph();
  const r = await runDemo(project);
  report("A) in-process (local parent)", r, checkDemo(r));
}

// B) project.parent is a REMOTE capnweb stub to the control plane (cross-isolate).
{
  const { controlPlane } = buildGraph();
  const wire = makeLinkedPair({ name: "project<->control-plane" });
  new RpcSession(wire.right, controlPlane); // control-plane side
  const cpStub = new RpcSession(wire.left, null).getRemoteMain(); // stub to the CP
  const project = new CapabilityHost("project");
  project.setParent(cpStub); // fall through, over capnweb, to another isolate

  const r = await runDemo(project);
  report("B) remote parent over capnweb (cross-isolate fallthrough)", r, checkDemo(r));
}

console.log("\n" + "=".repeat(64));
console.log(
  failed
    ? `❌ ${failed} FAILED`
    : "✅ ALL PASS (node) — uniform host, parent fallthrough, live+static, shadowing",
);
process.exit(failed ? 1 : 0);
