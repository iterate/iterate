// scripts/inspect-context.ts — print a context's durable log and subscription rows on the worker
// WORKER_BASE_URL/ADMIN_API_SECRET point at for inspection.
//   WORKER_BASE_URL=… ADMIN_API_SECRET=… PROJECT=prj-example CTX_PATH=/example pnpm exec tsx scripts/inspect-context.ts
import {
  adminCredentials,
  disposeSessions,
  readAll,
  session,
  subscriptions,
} from "../e2e/support/client.ts";

const project = process.env.PROJECT;
if (!project) throw new Error("PROJECT unset");
const path = process.env.CTX_PATH;
if (!path) throw new Error("CTX_PATH unset");
const itx = session().authenticate(adminCredentials()).projects.get(project).cd(path);
for (const e of await readAll(itx)) {
  const t = String(e.type).replace("events.iterate.com/", "");
  const p = JSON.stringify(e.payload ?? {});
  console.log(`${e.offset}\t${e.createdAt}\t${t}\t${p.length > 200 ? `${p.slice(0, 200)}…` : p}`);
}
console.log("subscriptions:", JSON.stringify(await subscriptions(itx)));
disposeSessions();
process.exit(0);
