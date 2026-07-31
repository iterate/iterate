// Prove the TWO-WORKER split end to end: control plane (front desk: identity + D1 directory + routing)
// dials the project worker (runner: loads + serves the confined config worker) over HTTP + a shared secret
// — the cross-account-shaped dial (topology 4). Also proves confinement (config worker sees only ITX).
import { newHttpBatchRpcSession } from "capnweb";

const CP = process.env.CP || "https://control-plane.iterate.workers.dev";
const EMAIL = `tw+${Date.now()}@example.com`;
const SLUG = `tw-${Date.now().toString(36)}`;
const HOST = `${SLUG}.example.com`;
let pass = 0,
  fail = 0;
const ok = (c, m) => {
  console.log(`${c ? "✅" : "❌"} ${m}`);
  c ? pass++ : fail++;
};

// 1. login → session cookie
const login = await fetch(`${CP}/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ email: EMAIL, next: "/" }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
ok(cookie.startsWith("kernel_auth_session="), "login → session cookie");

// 2. create a project via /api → get its minted prj_ id
const api = newHttpBatchRpcSession(new Request(`${CP}/api`, { headers: { cookie } }));
const created = api.authenticate().projects.create(SLUG);
const projectId = await created.projectId;
ok(/^prj_[a-f0-9]{32}$/.test(projectId), `created project ${SLUG} → ${projectId}`);

// 3. register a route: HOST → this project (the routes table in the control plane's D1)
const routeRes = await fetch(`${CP}/routes`, {
  method: "POST",
  redirect: "manual",
  headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ host: HOST, projectId, app: "" }),
});
ok(routeRes.status === 302, `registered route ${HOST} → ${projectId}`);

// 4. INGRESS: hit the control plane with the host; it resolves host→projectId from D1 and dials the
//    project worker, which loads + serves the confined config worker.
const ingress = await fetch(
  `${CP}/__ingress?host=${encodeURIComponent(HOST)}&path=${encodeURIComponent("/__debug")}`,
  {
    headers: { cookie },
  },
);
const body = await ingress.json().catch(() => ({}));
ok(
  body.projectId === projectId,
  `control plane resolved host→project & dialed the runner (served projectId=${body.projectId})`,
);
ok(
  Array.isArray(body.seenBindings) &&
    body.seenBindings.length === 1 &&
    body.seenBindings[0] === "ITX",
  `config worker is CONFINED — sees only [ITX] (${JSON.stringify(body.seenBindings)})`,
);
ok(
  JSON.stringify(body.caller).includes(EMAIL),
  `the caller identity rode through the dial (${JSON.stringify(body.caller)})`,
);

// 5. the default HTML app also serves through the dial
const htmlRes = await fetch(`${CP}/__ingress?host=${encodeURIComponent(HOST)}&path=/`, {
  headers: { cookie },
});
const html = await htmlRes.text();
ok(
  html.includes(projectId) && html.includes("project config worker"),
  "the project's default app renders via the runner",
);

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
