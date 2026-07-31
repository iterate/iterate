// Prove PUBLIC vs PRIVATE apps in a project worker. The default app is public (anyone); the "admin" app
// is private — the config worker calls `env.ITX.auth.fetch(request)` (forward-auth partial fetch), which
// returns null for an authorized member (proceed) or a login redirect otherwise. Membership is stamped by
// the control plane at dial time (design §11). Runs against the deployed workers (service-binding dial).
import { newHttpBatchRpcSession } from "capnweb";

const CP = process.env.CP || "https://control-plane.iterate.workers.dev";
const OWNER = `owner+${Date.now()}@example.com`;
const OUTSIDER = `outsider+${Date.now()}@example.com`;
const SLUG = `apps-${Date.now().toString(36)}`;
const HOST = `${SLUG}.example.com`;
let pass = 0,
  fail = 0;
const ok = (c, m) => {
  console.log(`${c ? "✅" : "❌"} ${m}`);
  c ? pass++ : fail++;
};

async function login(email) {
  const r = await fetch(`${CP}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, next: "/" }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
// hit project ingress for HOST at `path`, optionally with a session cookie; don't follow redirects.
async function visit(path, cookie) {
  return fetch(
    `${CP}/__ingress?host=${encodeURIComponent(HOST)}&path=${encodeURIComponent(path)}`,
    {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    },
  );
}

// setup: owner logs in, creates the project, registers the route.
const ownerCookie = await login(OWNER);
const api = newHttpBatchRpcSession(new Request(`${CP}/api`, { headers: { cookie: ownerCookie } }));
const projectId = await api.authenticate().projects.create(SLUG).projectId;
ok(/^prj_[a-f0-9]{32}$/.test(projectId), `owner created project ${SLUG} → ${projectId}`);
await fetch(`${CP}/routes`, {
  method: "POST",
  redirect: "manual",
  headers: { cookie: ownerCookie, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ host: HOST, projectId, app: "" }),
});
const outsiderCookie = await login(OUTSIDER);

// PUBLIC app (default, path "/") — everyone gets it.
const pubOwner = await visit("/", ownerCookie);
ok(
  pubOwner.status === 200 && (await pubOwner.text()).includes("PUBLIC"),
  "public app: owner sees it",
);
const pubAnon = await visit("/", null);
ok(
  pubAnon.status === 200 && (await pubAnon.text()).includes("PUBLIC"),
  "public app: anonymous sees it",
);
const pubOut = await visit("/", outsiderCookie);
ok(
  pubOut.status === 200 && (await pubOut.text()).includes("PUBLIC"),
  "public app: outsider sees it",
);

// PRIVATE app (path "/admin") — only a member; others get redirected to login.
const privOwner = await visit("/admin", ownerCookie);
ok(
  privOwner.status === 200 && (await privOwner.text()).includes("PRIVATE"),
  "private app: MEMBER (owner) is served",
);
const privAnon = await visit("/admin", null);
const anonLoc = privAnon.headers.get("location") || "";
ok(
  privAnon.status === 302 && anonLoc.includes("/login"),
  `private app: anonymous → redirected to login (${privAnon.status})`,
);
const privOut = await visit("/admin", outsiderCookie);
const outLoc = privOut.headers.get("location") || "";
ok(
  privOut.status === 302 && outLoc.includes("/login"),
  `private app: NON-member → redirected to login (${privOut.status})`,
);

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
