// Dial a deployed kernel's `/api` (capnweb HTTP batch) and fire the OS-root create chain:
//   os.authenticate({type:"anonymous"}) -> session.projects.get(slug).create({organizationSlug})
// The write lands via the kernel's AUTH service binding (createProjectForOrganization on auth-prd),
// so it needs only an existing org slug — no login. Usage:
//   node scripts/dial-create.mjs <host> <newSlug> <organizationSlug>
import { newHttpBatchRpcSession } from "capnweb";

const [, , host, newSlug, org] = process.argv;
if (!host || !newSlug || !org) {
  console.error("usage: node scripts/dial-create.mjs <host> <newSlug> <organizationSlug>");
  process.exit(1);
}
const url = `https://${host}/api`;
console.log(`dial ${url}\n  create '${newSlug}' under org '${org}'`);

try {
  const api = newHttpBatchRpcSession(url); // one HTTP batch, fully pipelined
  const created = api
    .authenticate({ type: "anonymous" })
    .projects.get(newSlug)
    .create({ organizationSlug: org });
  console.log("✅ CREATED — projectId:", await created.projectId);
} catch (e) {
  console.log("create ->", e?.message ?? String(e));
}

try {
  const api = newHttpBatchRpcSession(url); // fresh batch to verify existence
  console.log(
    "🔎 get after ->",
    await api.authenticate({ type: "anonymous" }).projects.get(newSlug).projectId,
  );
} catch (e) {
  console.log("get after ->", e?.message ?? String(e));
}
