// The public MCP endpoint with a person's personal access token, real repo and worker publication.
// No capability fakes.
import { newHttpBatchRpcSession } from "capnweb";
import { expect, test } from "vitest";
import type { IterateRpcTarget } from "../../../core/os/src/session.ts";
import { mcpCall, openItx, readAll, until, workerUrl } from "../../helpers/client.ts";
import { oauthSession } from "../../helpers/principal.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectUrl,
  registerProject,
} from "../../helpers/project-host.ts";

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

  // every script of the example the instructions link, sent as its source, as a client copies it
  const examples = await import(
    new URL("../../../core/os/examples/mcp-run-scripts.mjs", import.meta.url).href
  );
  expect(Object.keys(examples).sort()).toEqual([
    "appendNoteAndRemember",
    "listConfigFiles",
    "publishSite",
    "readPackageJson",
  ]);
  const files = await success(String(examples.listConfigFiles));
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
    "https://raw.githubusercontent.com/iterate/core/main/core/os/examples/mcp-run-scripts.mjs",
  );
  // Execute all examples exactly as a client copies them, in this isolated test project.
  const inline = [...description.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  );
  expect(inline).toHaveLength(4);
  const [starter, readWorker, editWorker, commitNote] = inline;
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
  // the edit example reads worker.ts at the tip, changes the text in the script, and commits with
  // that tip as parent
  const edited = await request("tools/call", { name: "run", arguments: editWorker });
  expect(edited, JSON.stringify(edited)).toMatchObject({
    isError: false,
    structuredContent: { result: { commitOid: expect.any(String), changedPaths: ["worker.ts"] } },
  });
  expect(await root.repos.get("/repos/config").readFile("worker.ts")).toBe(
    read.structuredContent.result.replace("Homepage of project ", "Welcome to "),
  );
  const noted = await request("tools/call", { name: "run", arguments: commitNote });
  expect(noted, JSON.stringify(noted)).toMatchObject({
    isError: false,
    structuredContent: { result: { commitOid: expect.any(String) } },
  });
  expect(await root.repos.get("/repos/config").readFile("notes.txt")).toBe("Hello from MCP");
  expect(await success(String(examples.readPackageJson))).toContain('"main": "worker.ts"');
  expect(await success(String(examples.appendNoteAndRemember))).toBe("root");
  // what the script wrote is for the person who asked for the run, through their grant; the
  // script itself called as the project's code
  expect((await readAll(root.cd("/notes/mcp"))).find((e) => e.type === "note")).toMatchObject({
    source: {
      origin: "/",
      onBehalfOf: {
        principal: { actor: principal.actor },
        grant: grantId,
        run: expect.stringMatching(/^\/@\d+$/),
      },
    },
  });
  expect(
    (await readAll(root.cd("/notes/mcp"))).find((e) => e.type === "note")?.source,
  ).not.toHaveProperty("principal");

  // the commit, and its outcome awaited as the instructions teach: once it is published, the site
  // serves the commit
  const commit = await success(String(examples.publishSite));
  expect(commit).toMatchObject({
    commitOid: expect.any(String),
    generation: expect.any(Number),
    projectUrl: expect.any(String),
  });
  // the script named no author: the commit is the person's who asked for the run, committed by the
  // platform, and names the run
  expect(
    (await root.repos.get("/repos/config").log({ limit: 5 })).find(
      (entry: { oid: string }) => entry.oid === commit.commitOid,
    ),
  ).toMatchObject({
    author: { name: member.email, email: member.email },
    committer: { name: "iterate", email: "config@iterate.com" },
    // the example's `Via:` trailer, and the run's beside it
    message: expect.stringMatching(
      /^Serve the page from a module of its own\n\nVia: Claude Code\nIterate-Run: \/@\d+$/,
    ),
  });
  const published = await fetchProjectUrl(projectUrl({ project: slug, path: "/" }));
  expect(published).toMatchObject({ status: 200, text: "<h1>Published over MCP</h1>" });
  expect(published.headers["content-type"]).toContain("text/html");
  const events = await readAll(root);
  expect(
    events.find(
      (e) =>
        e.type === "events.iterate.com/project/worker-updated" &&
        e.payload.commitOid === commit.commitOid,
    ),
  ).toBeDefined();
  const requested = events.filter((e) => e.type === "events.iterate.com/itx/run-requested");
  expect(requested.length).toBe(9);
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
  ).toEqual({
    origin: "/",
    cause: expect.objectContaining({ depth: 0 }),
    principal,
    grant: secondGrantId,
  });

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
