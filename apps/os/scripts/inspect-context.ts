// scripts/inspect-context.ts — print a context's durable log and subscription rows on the worker
// WORKER_BASE_URL points at, with ITERATE_BEARER_TOKEN, a personal access token for the project, or,
// for a project no key at hand covers, APP_CONFIG_ADMIN_API_SECRET, the deployment's operator bearer
// (`/api` accepts it; the CLI reads the same two, the operator's first) (docs/credentials.md).
//   WORKER_BASE_URL=… ITERATE_BEARER_TOKEN=itk_… PROJECT=prj-example CTX_PATH=/example pnpm exec tsx scripts/inspect-context.ts
import type { SessionCredentials } from "iterate/api";
import { disposeSessions, readAll, session, subscriptions } from "../e2e/support/client.ts";

const credentials = ((): SessionCredentials => {
  const operator = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (operator) return { type: "admin-secret", secret: operator };
  const token = process.env.ITERATE_BEARER_TOKEN?.trim();
  if (token) return { type: "bearer", token };
  throw new Error(
    "ITERATE_BEARER_TOKEN unset: a personal access token for PROJECT (or APP_CONFIG_ADMIN_API_SECRET, the operator bearer)",
  );
})();
const project = process.env.PROJECT;
if (!project) throw new Error("PROJECT unset");
const path = process.env.CTX_PATH;
if (!path) throw new Error("CTX_PATH unset");
const itx = session().authenticate(credentials).projects.get(project).cd(path);
for (const e of await readAll(itx)) {
  const t = String(e.type).replace("events.iterate.com/", "");
  const p = JSON.stringify(e.payload ?? {});
  console.log(`${e.offset}\t${e.createdAt}\t${t}\t${p.length > 200 ? `${p.slice(0, 200)}…` : p}`);
}
console.log("subscriptions:", JSON.stringify(await subscriptions(itx)));
disposeSessions();
process.exit(0);
