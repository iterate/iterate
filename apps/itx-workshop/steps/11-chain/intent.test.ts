// Intent: a context chain. An agent context's parent is its project context. On
// a capability MISS the agent climbs to the project (super); the agent's OWN caps
// (and roots) SHADOW the project's; and the project is unaffected by the agent.
//
//   npm run dev
//   node --experimental-strip-types steps/11-chain/intent.test.ts

import http from "node:http";
import { connect, sleep } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const projectUrl = `${WS}/steps/11-chain?project=alice`;
const agentUrl = `${WS}/steps/11-chain?project=alice&agent=foo`;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

function startMock(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, msg: u.searchParams.get("msg") }));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/echo`, close: () => server.close() });
    });
  });
}

async function main() {
  const mock = await startMock();
  try {
    // The PROJECT provides a capability (its connection stays open so the live
    // stub remains callable when the agent climbs to it).
    using project = connect<any>(projectUrl, bearer("alice-token"));
    await project.provideCapability(["db"], (async (q: string) => `project-db:${q}`) as any);
    await sleep(50);

    // The AGENT — a child context of the project.
    using agent = connect<any>(agentUrl, bearer("alice-token"));

    check(
      "agent inherits the project's cap via super (chain climb)",
      (await agent.invoke(["db"], ["q1"])) === "project-db:q1",
    );

    const f = await agent.fetch(`${mock.url}?msg=chain`);
    check(
      "agent inherits the project's itx.fetch root via the chain",
      JSON.parse(f.body)?.msg === "chain" && f.viaProject === "alice",
      `viaProject=${f?.viaProject}`,
    );

    // The agent provides its OWN db — it shadows the inherited one.
    await agent.provideCapability(["db"], (async (q: string) => `agent-db:${q}`) as any);
    await sleep(50);
    check(
      "the agent's own cap shadows the inherited one",
      (await agent.invoke(["db"], ["q2"])) === "agent-db:q2",
    );

    // The project is unaffected by the agent's shadow.
    check(
      "the project still sees its own cap (shadowing is child-local)",
      (await project.invoke(["db"], ["q3"])) === "project-db:q3",
    );
  } finally {
    mock.close();
  }

  console.log(`\n${failures === 0 ? "step 11 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
