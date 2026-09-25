// The public MCP endpoint with a person's personal access token, real repo and worker publication.
// No capability fakes.
import { newHttpBatchRpcSession } from "capnweb";
import { expect, test } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import { mcpCall, openItx, readAll, until, workerUrl } from "./support/client.ts";
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
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- One bounded token mint through the account API.
  using minter = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(workerUrl("/api"), { headers: issuerHeaders }),
  );
  const { token, id: grantId } = await minter
    .authenticate({ type: "from-server-cookie" })
    .grants.mint({ name: "MCP root regression", projects: [projectId] });
  const request = (method: string, params: unknown, bearer = token) =>
    mcpCall(method, params, bearer);
  const run = (script: string, project?: string) =>
    request("tools/call", { name: "run", arguments: { script, project } });
  const success = async (script: string) => {
    const result = await run(script);
    expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
    return result.structuredContent.result;
  };

  const files = await success('async (itx) => itx.repos.get("/repos/config").listFiles()');
  expect(files.paths).toContain("worker.ts");
  const discovery = await request("tools/list", {});
  const description = discovery.tools[0].description;
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "mcp-guidance-test", version: "1.0.0" },
  });
  expect(initialized.instructions).toContain(description);
  expect(description).toContain(
    "https://raw.githubusercontent.com/iterate/iterate/main/apps/os/e2e/mcp-project-root.e2e.test.ts",
  );
  // Execute all examples exactly as a client copies them, in this isolated test project.
  const examples = [...description.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  );
  expect(examples).toHaveLength(3);
  const [starter, readWorker, commitNote] = examples;
  const started = await request("tools/call", { name: "run", arguments: starter });
  expect(started, JSON.stringify(started)).toMatchObject({
    isError: false,
    structuredContent: {
      result: {
        identity: { projectId, path: "/" },
        capabilities: expect.arrayContaining([expect.objectContaining({ match: "itx.repos" })]),
      },
    },
  });
  const read = await request("tools/call", { name: "run", arguments: readWorker });
  expect(read, JSON.stringify(read)).toMatchObject({
    isError: false,
    structuredContent: { result: await root.repos.get("/repos/config").readFile("worker.ts") },
  });
  const probe = description.match(/`(itx\.workers\.get\(.*?)`/)![1];
  expect(
    await success(
      `async (itx) => { const candidateSource = ${JSON.stringify(read.structuredContent.result)}; const { projectUrl } = await itx.whoami(); const response = await ${probe}; return response.status; }`,
    ),
  ).toBe(200);
  const noted = await request("tools/call", { name: "run", arguments: commitNote });
  expect(noted, JSON.stringify(noted)).toMatchObject({
    isError: false,
    structuredContent: { result: { commitOid: expect.any(String) } },
  });
  expect(await root.repos.get("/repos/config").readFile("notes.txt")).toBe("Hello from MCP");
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
  expect(commit).toMatchObject({ commitOid: expect.any(String) });
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
        e.type === "events.iterate.com/itx/ingress-configured" &&
        e.payload.target[2][1].cacheKey === commit.commitOid,
    ),
  ).toBeDefined();
  const requested = events.filter((e) => e.type === "events.iterate.com/itx/run-requested");
  expect(requested.length).toBe(8);
  expect(
    requested.every(
      (e) => e.source.principal.actor === principal.actor && e.source.grant === grantId,
    ),
  ).toBe(true);
  expect(
    events
      .filter((e) => e.type === "events.iterate.com/itx/run-settled")
      .every((e) => e.payload.settlement.status === "succeeded"),
  ).toBe(true);

  // Two grants execute on the same root; attribution distinguishes their requests.
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- A second bounded mint for a separate MCP connection.
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
  expect(secondRun, JSON.stringify(secondRun)).toMatchObject({
    isError: false,
    structuredContent: { result: { projectId, path: "/" } },
  });
  const afterSecond = await readAll(root);
  const secondGrantId = second.id;
  expect(
    afterSecond.filter((e) => e.type === "events.iterate.com/itx/run-requested").at(-1)?.source,
  ).toEqual({ principal, grant: secondGrantId });

  const otherEvents = await readAll(openItx(other));
  const denied = await run(
    'async (itx) => itx.repos.get("/repos/config").readFile("worker.ts")',
    other,
  );
  expect(denied).toMatchObject({ isError: true });
  expect(denied.content[0].text).toContain("outside this token's grant");
  expect(await readAll(openItx(other))).toEqual(otherEvents);
  // Root policy still applies: MCP does not dispatch directly to the physical repo built-in.
  await root.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.repos", target: null },
  });
  const masked = await run('async (itx) => itx.repos.get("/repos/config").readFile("worker.ts")');
  expect(masked).toMatchObject({ isError: true });
  expect(masked.content[0].text).toContain("masked");
  expect(description).toContain("root `itx` handle");
});
