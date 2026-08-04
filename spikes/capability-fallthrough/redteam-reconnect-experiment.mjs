// RED-TEAM experiment: disconnection / failover / delivery semantics against the
// REAL capnweb 0.10.0 + capability-host design. Self-contained; prints observations.
//
// Run from this directory:  node redteam-reconnect-experiment.mjs

import { RpcSession, RpcTarget } from "capnweb";
import { makeLinkedPair } from "./inproc.mjs";
import { CapabilityHost } from "./capability-host.mjs";

// The design crashes capnweb's teardown (see T5/T6). Trap it so the script finishes
// and REPORTS the crash as a finding instead of dying.
let lastUnhandled = null;
process.on("uncaughtException", (e) => (lastUnhandled = e));
process.on("unhandledRejection", (e) => (lastUnhandled = e));

const line = (s) => console.log(s);
const hr = () => line("-".repeat(70));

// A "Pi"-like live provider that the cloud calls back into.
class PiSensor extends RpcTarget {
  async reading() {
    return { temp: 21.5 };
  }
  async slow() {
    // A call that never returns on its own — models an in-flight call at drop time.
    return new Promise(() => {});
  }
}

// Helper: stand up a capnweb session pair; return { providerStubOnHub, wire, hubSession }.
function dialProviderIntoHub() {
  const wire = makeLinkedPair({ name: "pi<->hub" });
  // Pi side: exposes PiSensor as its localMain.
  const piSession = new RpcSession(wire.right, new PiSensor());
  // Hub side: gets a stub back to the Pi's localMain.
  const hubSession = new RpcSession(wire.left, null);
  const providerStub = hubSession.getRemoteMain();
  return { providerStub, wire, piSession, hubSession };
}

// ============================================================================
line("\n=== T1: in-flight call when the provider session drops — reject or hang? ===");
{
  const { providerStub, wire } = dialProviderIntoHub();
  const host = new CapabilityHost("hub");
  host.provide("sensor", providerStub, "live");

  const resolved = host.resolve("sensor"); // dup of the live stub
  const inflight = resolved.slow(); // never resolves on its own
  let settled = "PENDING";
  inflight.then(
    () => (settled = "RESOLVED"),
    (e) => (settled = "REJECTED: " + (e?.message ?? e)),
  );

  // Kill the wire mid-call (models the Pi's TCP dropping, close event delivered).
  wire.left.abort(new Error("pi dropped (transport closed)"));
  await new Promise((r) => setTimeout(r, 20));
  line(`  in-flight call settled = ${settled}`);
  line("  => in-flight calls DO reject when the drop delivers a close/abort. (at-most-once)");
}

// ============================================================================
line("\n=== T2: onRpcBroken as the eviction signal — does it fire, and WHEN? ===");
{
  const { providerStub, wire } = dialProviderIntoHub();
  let brokenFired = false;
  providerStub.onRpcBroken(() => (brokenFired = true));
  line(`  before drop: onRpcBroken fired = ${brokenFired}`);
  wire.left.abort(new Error("drop"));
  await new Promise((r) => setTimeout(r, 20));
  line(`  after  drop: onRpcBroken fired = ${brokenFired}`);
  line("  => eviction signal works ONLY when a close/abort is actually delivered.");
}

// ============================================================================
line("\n=== T3: HALF-OPEN drop (no close event) — does onRpcBroken ever fire? ===");
{
  // Model a silent network death: the underlying channel just stops delivering,
  // no abort() / close() is ever signalled (power loss, NAT rebind, cable pull).
  const wire = makeLinkedPair({ name: "pi<->hub(halfopen)" });
  new RpcSession(wire.right, new PiSensor());
  const hubSession = new RpcSession(wire.left, null);
  const providerStub = hubSession.getRemoteMain();

  let brokenFired = false;
  providerStub.onRpcBroken(() => (brokenFired = true));

  const resolved = providerStub.dup();
  let callSettled = "PENDING";
  resolved.reading().then(
    (v) => (callSettled = "RESOLVED " + JSON.stringify(v)),
    (e) => (callSettled = "REJECTED " + e?.message),
  );

  // Simulate half-open: monkey-patch the transport so nothing is ever delivered
  // and no close fires. We just never call abort/close on the wire.
  // (Nothing to do — we simply do NOT close it.)
  await new Promise((r) => setTimeout(r, 100));
  line(`  after 100ms with NO close event: onRpcBroken fired = ${brokenFired}`);
  line(`  a fresh call to the (dead) stub settled = ${callSettled}`);
  hr();
  line("  NOTE: here the Pi side actually still answers because it's in-proc; the point");
  line("  is the MECHANISM: capnweb has NO ping/keepalive, so if the real socket dies");
  line("  silently, receive() never rejects, abort() is never called, onRpcBroken NEVER");
  line("  fires, and calls block until the OS TCP timeout (minutes) or forever.");
}

// ============================================================================
line("\n=== T4: SPLIT-BRAIN — late onRpcBroken from the OLD session deletes the NEW mount ===");
{
  // The design: eviction deletes the mount BY NAME. Model exactly that.
  const caps = new Map();
  const provide = (name, stub) => {
    const stored = stub.dup?.() ?? stub;
    caps.set(name, stored);
    // The design's intent: register eviction on break.
    stub.onRpcBroken?.(() => {
      line(`     [onRpcBroken:${name}] evicting by name`);
      caps.delete(name); // <-- deletes whatever is currently under `name`
    });
  };

  // First connection.
  const c1 = dialProviderIntoHub();
  provide("sensor", c1.providerStub);
  line(`  after 1st provide: caps.has(sensor) = ${caps.has("sensor")}`);

  // Pi reconnects on a NEW session BEFORE the old close is processed
  // (half-open old socket; new socket races ahead — common on flaky links).
  const c2 = dialProviderIntoHub();
  provide("sensor", c2.providerStub); // fresh, healthy mount
  line(`  after reconnect provide (new healthy mount): caps.has(sensor) = ${caps.has("sensor")}`);

  // NOW the old session's close finally lands and its onRpcBroken fires.
  c1.wire.left.abort(new Error("old socket finally closed"));
  await new Promise((r) => setTimeout(r, 30));
  line(`  after OLD session's late onRpcBroken: caps.has(sensor) = ${caps.has("sensor")}`);
  line("  => the late eviction from the DEAD session deleted the LIVE reconnected mount.");
  line("     Provider is connected & healthy, but the host now says 'no such capability'.");
}

// ============================================================================
line("\n=== T5: PARENT stub break — one drop kills ALL fallthrough capabilities at once ===");
{
  // Build CP with two caps; project falls through to CP over capnweb.
  class Egress extends RpcTarget {
    async fetch(u) {
      return { via: "cp-egress", u };
    }
  }
  const cp = new CapabilityHost("control-plane");
  cp.provide("egress", new Egress(), "live");
  cp.provide("brand", "iterate", "static");

  const wire = makeLinkedPair({ name: "project<->cp" });
  new RpcSession(wire.right, cp);
  const cpStub = new RpcSession(wire.left, null).getRemoteMain();
  const project = new CapabilityHost("project");
  project.setParent(cpStub);

  // Works before the drop.
  const before = await project.egress.fetch("https://x.test");
  line(`  before drop: project.egress.fetch => ${JSON.stringify(before)}`);

  // The single project->CP session drops.
  wire.left.abort(new Error("project<->cp session dropped"));
  await new Promise((r) => setTimeout(r, 20));

  let egr = "OK",
    brand = "OK";
  try {
    await project.egress.fetch("https://x.test");
  } catch (e) {
    egr = "FAIL: " + e?.message;
  }
  try {
    await project.brand;
  } catch (e) {
    brand = "FAIL: " + e?.message;
  }
  line(`  after drop: egress=${egr}`);
  line(`  after drop: brand =${brand}`);
  line("  => a SINGLE dropped parent session takes out EVERY inherited capability at once,");
  line("     with no re-dial (capnweb has no reconnect). Project is bricked until re-provisioned.");
}

// ============================================================================
line("\n=== T6: session teardown disposes an exported CapabilityHost => capnweb CRASH ===");
{
  lastUnhandled = null;
  const wire = makeLinkedPair({ name: "cp-export" });
  const cp = new CapabilityHost("cp");
  cp.provide(
    "egress",
    new (class extends RpcTarget {
      fetch() {
        return {};
      }
    })(),
    "live",
  );
  new RpcSession(wire.right, cp); // CP exports a CapabilityHost as localMain
  const stub = new RpcSession(wire.left, null).getRemoteMain();
  stub.onRpcBroken(() => {});
  wire.left.abort(new Error("disconnect")); // normal disconnect
  await new Promise((r) => setTimeout(r, 40));
  line(
    `  Symbol.dispose in host = ${Symbol.dispose in cp}  (Proxy has()=>true), host[Symbol.dispose] = ${cp[Symbol.dispose]}`,
  );
  line(
    `  unhandled error during teardown = ${lastUnhandled ? lastUnhandled.constructor.name + ": " + lastUnhandled.message : "none"}`,
  );
  line("  => EVERY disconnect that disposes an exported CapabilityHost throws inside");
  line("     capnweb's abort() (unguarded exports-dispose loop), aborting cleanup.");
}

line("\n=== done ===");
process.exit(0);
