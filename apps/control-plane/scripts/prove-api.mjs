// Prove the capnweb /api on the control plane: login → session cookie → authenticate() → whoami() +
// projects.create() + projects.list(), all pipelined in one capnweb batch.
import { newHttpBatchRpcSession } from "capnweb";

const BASE = process.env.BASE || "https://control-plane.iterate.workers.dev";
const EMAIL = `api+${Date.now()}@example.com`;
const SLUG = `api-${Date.now().toString(36)}`;
let pass = 0,
  fail = 0;
const ok = (c, m) => {
  console.log(`${c ? "✅" : "❌"} ${m}`);
  c ? pass++ : fail++;
};

// 1. login → session cookie
const login = await fetch(`${BASE}/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ email: EMAIL, next: "/" }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
ok(cookie.startsWith("kernel_auth_session="), "login → session cookie");

// 2. capnweb /api with the cookie — pipeline authenticate/whoami/create/list in one batch
const api = newHttpBatchRpcSession(new Request(`${BASE}/api`, { headers: { cookie } }));
const session = api.authenticate();
const who = session.whoami();
const created = session.projects.create(SLUG);
const [whoR, createdId, createdSlug] = await Promise.all([
  who,
  created.projectId,
  created.projectSlug,
]);

ok(whoR?.email === EMAIL.toLowerCase(), `/api authenticate().whoami() (${whoR?.email})`);
ok(
  /^prj_[a-f0-9]{32}$/.test(createdId) && createdSlug === SLUG,
  `/api projects.create() → minted prj_ id + globally-unique slug (${createdId}, ${createdSlug})`,
);

// Fresh batch — the create above has committed, so list() reflects it (avoids intra-batch races).
const list2 = newHttpBatchRpcSession(new Request(`${BASE}/api`, { headers: { cookie } }));
const listR = await list2.authenticate().projects.list();
ok(
  Array.isArray(listR) && listR.includes(SLUG),
  `/api projects.list() shows it (${JSON.stringify(listR)})`,
);

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
