import { adminCredentials, disposeSessions, session } from "../e2e/support/client.ts";
const project = process.env.PROJECT || "dawg";
const itx = session().authenticate(adminCredentials()).projects.get(project);
const j = (v: unknown) => JSON.parse(JSON.stringify(v));
const readAll = async (ctx: any) => {
  const out: any[] = [];
  let after = 0;
  for (;;) {
    const page: any = j(await ctx.invoke(["itx", "builtins", ["readEvents", after, 500]]));
    const events = page.events ?? page;
    out.push(...events);
    if (events.length < 500 || out.length > 4000) break;
    after = events[events.length - 1].offset;
  }
  return out;
};
console.log("whoami:", JSON.stringify(j(await itx.invoke("itx.whoami()"))));
console.log("agents:", JSON.stringify(j(await itx.invoke("itx.agents.list()"))));
console.log("repos:", JSON.stringify(j(await itx.invoke("itx.repos.list()"))));
console.log("config tip:", JSON.stringify(j(await itx.invoke("itx.repos.get('/repos/config').tip()"))));
console.log("config log:", JSON.stringify(j(await itx.invoke("itx.repos.get('/repos/config').log({ limit: 10 })")), null, 0).slice(0, 2000));
const core: any = j(await itx.invoke("itx.cd('/').facets.get('core').snapshot()"));
console.log("ingressTarget:", JSON.stringify(core.state.ingressTarget));
const root = await readAll(itx);
console.log(`root log: ${root.length} events`);
for (const e of root) {
  const t = String(e.type).replace("events.iterate.com/", "");
  if (/ingress|repo\/|project\/|agent\/created|run-/.test(t))
    console.log(`  ${e.offset}\t${e.createdAt}\t${t}\t${JSON.stringify(e.payload ?? {}).slice(0, 300)}`);
}
const agents: any[] = j(await itx.invoke("itx.agents.list()"));
const which = process.env.AGENT ? agents.filter((a) => a.path === process.env.AGENT) : agents.slice(-2);
for (const a of which) {
  const ctx = itx.cd(a.path);
  const events = await readAll(ctx);
  console.log(`\n=== ${a.path}: ${events.length} events ===`);
  for (const e of events) {
    const t = String(e.type).replace("events.iterate.com/", "");
    const p = e.payload ?? {};
    let summary = "";
    if (t === "context/run-requested") summary = `SCRIPT: ${String(p.script ?? p.code ?? JSON.stringify(p)).replace(/\s+/g, " ").slice(0, 700)}`;
    else if (t === "context/run-settled") summary = p.error ? `ERROR: ${String(p.error).slice(0, 700)}` : `ok: ${JSON.stringify(p.result ?? p).slice(0, 300)}`;
    else if (/context-added|message-sent/.test(t)) summary = `${p.role ?? ""} ${String(p.message ?? p.text ?? p.content ?? JSON.stringify(p)).replace(/\s+/g, " ").slice(0, 500)}`;
    else if (/llm-request-settled/.test(t)) summary = JSON.stringify(p).slice(0, 300);
    else if (/llm-request-requested|chunks|summary/.test(t)) continue;
    else summary = JSON.stringify(p).slice(0, 200);
    console.log(`${e.offset}\t${String(e.createdAt).slice(11, 19)}\t${t}\t${summary}`);
  }
}
disposeSessions();
process.exit(0);
