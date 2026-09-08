// library-mcp-server.e2e.test.ts — THE MACHINE LANE (src/library/mcp-server.ts + the bearer at
// ingress, worker.ts): `itx.serveMcp()` mounted as an app (`provide("itx.apps.mcp",
// "itx.serveMcp()")`) is an MCP server at `mcp--<projectId>.<base>/` — `initialize`, `tools/list`
// with the one tool `itx.invoke`, and a `tools/call` that is an ordinary itx invocation through the
// context's rules; an expression error is an `isError` tool result, never a 500. WHO: a project
// token as `Authorization: Bearer` stamps the principal exactly as the host cookie does — an
// appended event carries `source.principal` — while no bearer, or a bearer for another project,
// stamps nothing; the app never sees the token; the bearer wins over the cookie.

import { expect, test } from "vitest";
import { openItx, readAll } from "./support/client.ts";
import { mintProjectToken } from "./support/principal.ts";
import {
  fetchProjectHost,
  freshDnsSafeProjectId,
  projectHostnameBase,
  registerProject,
} from "./support/project-host.ts";

/** One JSON-RPC request on the MCP host, as an MCP client sends it; the JSON-RPC message back (a
 *  JSON body, or one SSE `data:` frame). */
async function mcp(
  host: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; message: any; text: string }> {
  const answer = await fetchProjectHost(
    host,
    "/",
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
  );
  const data = answer.text.startsWith("event:")
    ? (answer.text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice("data:".length)
    : answer.text;
  let message: unknown = null;
  try {
    message = JSON.parse(data);
  } catch {
    /* not JSON — the caller reads `text` */
  }
  return { status: answer.status, message, text: answer.text };
}

/** `tools/call` of `itx.invoke`: the tool result. */
async function invokeTool(
  host: string,
  input: { expression: unknown; args?: unknown[] },
  headers: Record<string, string> = {},
): Promise<{ status: number; isError?: boolean; text: string; result?: unknown }> {
  const { status, message, text } = await mcp(
    host,
    "tools/call",
    { name: "itx.invoke", arguments: input },
    headers,
  );
  const result = message?.result as
    | { content: { text: string }[]; structuredContent?: { result: unknown }; isError?: boolean }
    | undefined;
  if (!result) return { status, text };
  return {
    status,
    isError: result.isError,
    text: result.content[0]?.text ?? "",
    result: result.structuredContent?.result,
  };
}

/** An app that echoes what it was handed: the principal stamp and the auth headers. */
const SRC_ECHO = {
  "cap.js": String.raw`import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
    });
  }
}`,
};

test("itx.serveMcp() mounted at itx.apps.mcp: initialize, tools/list shows itx.invoke, a tools/call is an ordinary itx invocation (string and parsed forms, args appended), an expression error is an isError result", async () => {
  const projectId = freshDnsSafeProjectId("mcp");
  await registerProject(projectId);
  const itx = openItx(projectId);
  await itx.provide("itx.apps.mcp", "itx.serveMcp()");
  const host = `mcp--${projectId}.${projectHostnameBase()}`;

  const initialized = await mcp(host, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "library-mcp-server.e2e", version: "0" },
  });
  expect(initialized.status, initialized.text).toBe(200);
  expect(initialized.message.result.serverInfo).toMatchObject({ name: "iterate-context" });
  const listed = await mcp(host, "tools/list", {});
  expect(listed.status, listed.text).toBe(200);
  expect(listed.message.result.tools.map((t: { name: string }) => t.name)).toEqual(["itx.invoke"]);

  // a tools/call IS `itx.kv.put('k','v')` — the dotted string, then the parsed form, then args
  const put = await invokeTool(host, { expression: "itx.kv.put('k', 'v')" });
  expect(put.status, put.text).toBe(200);
  expect(put.isError, put.text).toBeFalsy();
  expect(put.result).toEqual({ ok: true });
  expect((await invokeTool(host, { expression: ["itx", "kv", ["get", "k"]] })).result).toBe("v");
  expect((await invokeTool(host, { expression: "itx.kv.get", args: ["k"] })).result).toBe("v");
  // the same kv the session sees: the tool ran in the context, through its rules
  expect(await itx.kv.get("k")).toBe("v");
  // a user rule applies to a tool call exactly as to any call
  await itx.provide("itx.greet", "itx.kv.get('k')");
  expect((await invokeTool(host, { expression: "itx.greet" })).result).toBe("v");

  // an expression no rule matches: a tool FAILURE (isError), a 200 — never a 500
  const missing = await invokeTool(host, { expression: "itx.nope.run()" });
  expect(missing.status, missing.text).toBe(200);
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("NO_ITX_EXPRESSION_MATCH");
  const unparsable = await invokeTool(host, { expression: "itx.kv.get(" });
  expect(unparsable.status).toBe(200);
  expect(unparsable.isError).toBe(true);
});

test("WHO on the machine lane: a bearer for this project stamps source.principal on what a tools/call appends; no bearer or another project's bearer stamps nothing; the app never sees the token; the bearer wins over the cookie", async () => {
  const projectId = freshDnsSafeProjectId("mcp-who");
  await registerProject(projectId);
  const base = projectHostnameBase();
  const itx = openItx(projectId);
  await itx.provide("itx.apps.mcp", "itx.serveMcp()");
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO }]]);
  const mcpHost = `mcp--${projectId}.${base}`;
  const principal = { actor: "user_ada", email: "ada@example.com" };
  const token = await mintProjectToken({ projectId, ...principal });
  const foreign = await mintProjectToken({ projectId: `${projectId}-other`, ...principal });
  const note = (n: number) => ({
    expression: `itx.append({ type: 'note', payload: { n: ${n} } })`,
  });

  // with the bearer: the appended event carries the token's actor — in the receipt and in the log
  const withBearer = await invokeTool(mcpHost, note(1), { authorization: `Bearer ${token}` });
  expect(withBearer.isError, withBearer.text).toBeFalsy();
  expect((withBearer.result as any[])[0].source.principal).toEqual(principal);
  // without a bearer: no principal; a bearer for another project: none either (and no refusal —
  // the app decides who may call; the platform only attributes)
  expect((await invokeTool(mcpHost, note(2))).isError).toBeFalsy();
  const foreignAnswer = await invokeTool(mcpHost, note(3), { authorization: `Bearer ${foreign}` });
  expect(foreignAnswer.isError, foreignAnswer.text).toBeFalsy();
  const events = await readAll(itx);
  const noteOf = (n: number) => events.find((e) => e.type === "note" && e.payload?.n === n);
  expect(noteOf(1)?.source?.principal).toEqual(principal);
  expect(noteOf(2)?.source?.principal).toBeUndefined();
  expect(noteOf(3)?.source?.principal).toBeUndefined();

  // the app never sees a project token; the bearer wins over the cookie; an app's own bearer passes
  const echoHost = `echo--${projectId}.${base}`;
  const cookieToken = await mintProjectToken({ projectId, actor: "user_cookie" });
  const seen = JSON.parse(
    (
      await fetchProjectHost(echoHost, "/", {
        authorization: `Bearer ${token}`,
        cookie: `itx-project-session=${cookieToken}; theme=dark`,
      })
    ).text,
  );
  expect(seen.principal).toEqual(principal);
  expect(seen.authorization).toBeNull();
  expect(seen.cookie).toBe("theme=dark");
  const foreignSeen = JSON.parse(
    (await fetchProjectHost(echoHost, "/", { authorization: `Bearer ${foreign}` })).text,
  );
  expect(foreignSeen.principal).toBeNull();
  expect(foreignSeen.authorization).toBeNull(); // another project's token is still the platform's
  const ownScheme = JSON.parse(
    (await fetchProjectHost(echoHost, "/", { authorization: "Bearer the-apps-own-token" })).text,
  );
  expect(ownScheme.principal).toBeNull();
  expect(ownScheme.authorization).toBe("Bearer the-apps-own-token");
});
