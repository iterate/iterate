// The public MCP endpoint, real OAuth grant, real repo and worker publication. No capability fakes.
// eslint-disable-next-line iterate/no-capnweb-http-batch -- Bounded account token mints; MCP itself uses its public HTTP protocol.
import { newHttpBatchRpcSession } from "capnweb";
import { expect, test } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import { openItx, readAll, until, workerUrl } from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
  registerProject,
} from "./support/project-host.ts";

test("MCP has its authorized project's root capabilities: read, commit, publish, navigate, and respect project boundaries", async () => {
  const slug = freshDnsSafeProjectSlug("mcp-root");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const other = await registerProject(freshDnsSafeProjectSlug("mcp-other"), member);
  const root = openItx(projectId);
  await until("config repo seeded", async () =>
    (await readAll(root)).find((e) => e.type === "events.iterate.com/project/created"),
  );
  const { issuerHeaders, principal } = await oauthSession(projectId, member);
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One bounded token mint through the account API.
  using minter = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(workerUrl("/api"), { headers: issuerHeaders }),
  );
  const { token } = await minter
    .authenticate({ type: "from-server-cookie" })
    .grants.mint({ name: "MCP root regression", projects: [projectId] });
  const grantId = token.split(":")[1]!;
  const oldPath = `/mcp/inbound/grants/${grantId}`;
  // An existing connection from before root execution, with its original transcript.
  // Root execution does not alter that child's rules or erase its transcript.
  await root.append({
    type: "events.iterate.com/project/mcp-connection-created",
    payload: { grantId, path: oldPath },
  });
  await root.cd(oldPath).append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.repos", target: null },
  });
  const oldEvents = await readAll(root.cd(oldPath));
  let id = 0;
  const request = async (method: string, params: unknown, bearer = token) => {
    const response = await fetch(process.env.MCP_BASE_URL || workerUrl("/mcp"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const message = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(
          body
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
        )
      : JSON.parse(body);
    expect(message.error, body).toBeUndefined();
    return message.result;
  };
  const run = (script: string, project?: string) =>
    request("tools/call", { name: "run", arguments: { script, project } });
  const success = async (script: string) => {
    const result = await run(script);
    expect(result.isError, JSON.stringify(result)).toBe(false);
    return result.structuredContent.result;
  };

  const files = await success('async (itx) => itx.repos.get("/repos/config").listFiles()');
  expect(files.paths).toContain("worker.ts");
  const identity = await success("async (itx) => itx.whoami()");
  expect(identity).toMatchObject({ projectId, path: "/" });
  expect(
    await success('async (itx) => itx.repos.get("/repos/config").readFile("AGENTS.md")'),
  ).toContain("Project configuration");
  expect(
    await success(
      'async (itx) => { await itx.cd("/notes/mcp").append({ type: "note", payload: { ok: true } }); await itx.kv.put("mcp", "root"); return itx.kv.get("mcp"); }',
    ),
  ).toBe("root");
  expect((await readAll(root.cd("/notes/mcp"))).some((e) => e.type === "note")).toBe(true);

  const changes = [
    { path: "app/page.js", content: 'export const html = "<h1>MCP config repo publication</h1>";' },
    {
      path: "worker.ts",
      content:
        'import { WorkerEntrypoint } from "cloudflare:workers"; import { html } from "./app/page.js"; export default class extends WorkerEntrypoint { fetch() { return new Response(html, { headers: { "content-type": "text/html" } }); } }',
    },
  ];
  const commit = await success(
    `async (itx) => itx.repos.get("/repos/config").commitFiles(${JSON.stringify({ message: "MCP root regression", changes })})`,
  );
  expect(commit.commitOid).toEqual(expect.any(String));
  const published = await until("MCP commit serves the site", async () => {
    const result = await fetchProjectUrl(projectUrl({ project: slug, path: "/" }));
    return result.status === 200 && result.text === "<h1>MCP config repo publication</h1>"
      ? result
      : undefined;
  });
  expect(published.headers["content-type"]).toContain("text/html");
  const events = await readAll(root);
  expect(
    events.find(
      (e) =>
        e.type === "events.iterate.com/project/ingress-configured" &&
        e.payload.target[2][1].cacheKey === commit.commitOid,
    ),
  ).toBeDefined();
  const requested = events.filter((e) => e.type === "events.iterate.com/context/run-requested");
  expect(requested.length).toBe(5);
  expect(
    requested.every(
      (e) => e.source.principal.actor === principal.actor && e.source.grant === grantId,
    ),
  ).toBe(true);
  expect(
    events
      .filter((e) => e.type === "events.iterate.com/context/run-settled")
      .every((e) => e.payload.settlement.status === "succeeded"),
  ).toBe(true);
  expect(await root.mcpConnections.list()).toEqual([
    { grantId, path: "/", createdAt: expect.any(String) },
  ]);
  expect(await readAll(root.cd(oldPath))).toEqual(oldEvents);

  // Two grants in one root must not collide on the connection certificate's idempotency key.
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- A second bounded mint for a separate MCP connection.
  using secondMinter = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(workerUrl("/api"), { headers: issuerHeaders }),
  );
  const second = await secondMinter
    .authenticate({ type: "from-server-cookie" })
    .grants.mint({ name: "Second MCP connection", projects: [projectId] });
  const secondRun = await request(
    "tools/call",
    { name: "run", arguments: { script: "async (itx) => itx.whoami()" } },
    second.token,
  );
  expect(secondRun.isError, JSON.stringify(secondRun)).toBe(false);
  expect(
    (await root.mcpConnections.list())
      .map((connection: { grantId: string }) => connection.grantId)
      .sort(),
  ).toEqual([grantId, second.token.split(":")[1]].sort());

  const otherEvents = await readAll(openItx(other));
  const denied = await run(
    'async (itx) => itx.repos.get("/repos/config").readFile("worker.ts")',
    other,
  );
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain("outside this token's grant");
  expect(await readAll(openItx(other))).toEqual(otherEvents);
  // Root policy still applies: MCP does not dispatch directly to the physical repo built-in.
  await root.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.repos", target: null },
  });
  const masked = await run('async (itx) => itx.repos.get("/repos/config").readFile("worker.ts")');
  expect(masked.isError).toBe(true);
  expect(masked.content[0].text).toContain("masked");
  const discovery = await request("tools/list", {});
  expect(discovery.tools[0].description).toContain("root `itx` handle");
  expect(discovery.tools[0].description).not.toContain("/mcp/inbound/");
});
