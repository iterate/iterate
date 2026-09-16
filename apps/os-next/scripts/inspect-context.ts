// scripts/inspect-context.ts — print a context's durable log and subscription rows on the worker
// WORKER_BASE_URL/ADMIN_API_SECRET point at (an operator's `tail -f` for one conversation).
//   PROJECT=prj-voice CTX_PATH=/calls/abc pnpm exec tsx scripts/inspect-context.ts
import { adminCredentials, disposeSessions, session } from "../e2e/support/client.ts";

const project = process.env.PROJECT || "prj-voice";
const path = process.env.CTX_PATH;
if (!path) throw new Error("CTX_PATH unset");
const itx = session().authenticate(adminCredentials()).projects.get(project).cd(path);
const page: any = await itx.invoke(["itx", "builtins", ["readEvents", 0, 500]]);
const events: any[] = JSON.parse(JSON.stringify(page.events ?? page));
for (const e of events) {
  const t = String(e.type).replace("events.iterate.com/", "");
  const p = JSON.stringify(e.payload ?? {});
  console.log(`${e.offset}\t${e.createdAt}\t${t}\t${p.length > 200 ? `${p.slice(0, 200)}…` : p}`);
}
const subs: any = await itx.invoke(["itx", "subscriptions", ["list"]]);
console.log("subscriptions:", JSON.stringify(JSON.parse(JSON.stringify(subs))).slice(0, 1200));
disposeSessions();
process.exit(0);
