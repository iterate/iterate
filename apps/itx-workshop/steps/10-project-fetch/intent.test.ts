// Intent: a project-scoped itx is born with `itx.fetch` — a root capability,
// provided (not built in), backed by that project's own Project Durable Object.
// Calling itx.fetch(url) egresses THROUGH the Project DO, tagged with the project.
//
// We get a project context the real way (Step 08 auth: token + project), then
// call itx.fetch on the NAKED stub (it resolves to the injected `fetch` root).
//
//   npm run dev
//   node --experimental-strip-types steps/10-project-fetch/intent.test.ts

import http from "node:http";
import { connect } from "../../client-lib.ts";

const WS = (process.env.ITX_BASE ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const authUrl = (project: string) => `${WS}/steps/08-auth?project=${project}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A real HTTP endpoint for the Project DO to egress to.
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
    using itx = connect<any>(authUrl("alice"), bearer("alice-token"));
    const res = await itx.fetch(`${mock.url}?msg=hello`);
    check(
      "itx.fetch on a project context egresses through the Project DO",
      res?.status === 200 && JSON.parse(res.body)?.msg === "hello" && res?.viaProject === "alice",
      `status=${res?.status} viaProject=${res?.viaProject} body=${res?.body}`,
    );

    using itxBob = connect<any>(authUrl("bob"), bearer("bob-token"));
    const resBob = await itxBob.fetch(`${mock.url}?msg=hi`);
    check(
      "a different project egresses through ITS OWN Project DO",
      resBob?.viaProject === "bob",
      `viaProject=${resBob?.viaProject}`,
    );
  } finally {
    mock.close();
  }

  console.log(`\n${failures === 0 ? "step 10 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
