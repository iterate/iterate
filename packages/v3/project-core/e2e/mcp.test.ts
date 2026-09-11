import assert from "node:assert/strict";
import { test } from "node:test";
import { api, base, browserHeaders, project, timeout } from "./support.ts";
import { setting } from "./support.ts";

let accessToken = "";
async function authorize(project: string) {
  const post = (path: string, body: BodyInit, headers = {}) =>
    fetch(new URL(path, base), {
      method: "POST",
      body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
  const redirect_uri = "http://localhost:9876/callback";
  const registered = await post(
    "/register",
    JSON.stringify({
      client_name: "Project core E2E",
      redirect_uris: [redirect_uri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    { "content-type": "application/json" },
  );
  assert.equal(registered.status, 201, await registered.clone().text());
  const { client_id } = (await registered.json()) as { client_id: string };
  const code_verifier = "proof-of-concept-pkce-verifier-for-this-client-only";
  const code_challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code_verifier)),
  ).toString("base64url");
  const query = new URLSearchParams({
    client_id,
    redirect_uri,
    response_type: "code",
    scope: "project",
    resource: `${base}/mcp`,
    state: "e2e",
    code_challenge,
    code_challenge_method: "S256",
  });
  const approved = await post(
    `/authorize?${query}`,
    new URLSearchParams({ project }),
    browserHeaders,
  );
  assert.equal(approved.status, 302, await approved.text());
  const redirect = new URL(approved.headers.get("location")!);
  assert.equal(redirect.searchParams.get("state"), "e2e");
  const tokens = await post(
    "/token",
    new URLSearchParams({
      client_id,
      redirect_uri,
      code_verifier,
      code: redirect.searchParams.get("code")!,
      grant_type: "authorization_code",
      resource: `${base}/mcp`,
    }),
  );
  assert.equal(tokens.status, 200, await tokens.clone().text());
  accessToken = ((await tokens.json()) as { access_token: string }).access_token;
  assert.ok(accessToken);
}

async function mcp(id: string, body: unknown) {
  const url = new URL("/mcp", base);
  url.searchParams.set("project", id);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

function request(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function invoke(projectId: string, id: number, method: string[], args: unknown[]) {
  return mcp(
    projectId,
    request(id, "tools/call", { name: "iterate", arguments: { method, args } }),
  );
}

test("serves the stateless MCP tool over public HTTP", { timeout, skip: !base }, async () => {
  const id = project();
  await authorize(id);
  const outside = await fetch(`${base}/mcp?project=not-granted`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(outside.status, 403);
  const initialized = await mcp(
    id,
    request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    }),
  );
  assert.equal(initialized.status, 200);
  assert.ok(initialized.body);
  assert.equal(
    (initialized.body.result as { protocolVersion: string }).protocolVersion,
    "2025-03-26",
  );
  assert.equal(
    (await mcp(id, { jsonrpc: "2.0", method: "notifications/initialized" })).status,
    202,
  );
  const listed = await mcp(id, request(2, "tools/list", {}));
  assert.ok(listed.body);
  assert.equal((listed.body.result as { tools: Array<{ name: string }> }).tools[0].name, "iterate");
  const event = { id: "mcp-note", type: "note", data: { via: "mcp" } };
  const appended = await invoke(id, 3, ["append"], [event]);
  assert.ok(appended.body);
  assert.equal((appended.body.result as { isError?: boolean }).isError, undefined);
  const log = (await api(id, ["readEvents"], [{ afterOffset: 0, limit: 128 }])).body as {
    result: unknown;
  };
  assert.deepEqual(
    (log.result as { events: unknown[] }).events.map((entry) => ({
      id: (entry as typeof event).id,
      type: (entry as typeof event).type,
      data: (entry as typeof event).data,
    })),
    [event],
  );
  const unknown = await mcp(id, request(4, "missing/method"));
  assert.ok(unknown.body);
  assert.equal((unknown.body.error as { code: number }).code, -32601);
  const invalid = await invoke(id, 5, [], []);
  assert.ok(invalid.body);
  assert.equal((invalid.body.error as { code: number }).code, -32602);
  await invoke(
    id,
    6,
    ["append"],
    [
      setting("trust", "trust", {
        keys: ["ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        minLevel: 1,
      }),
    ],
  );
  const denied = await invoke(id, 7, ["append"], [{ id: "denied", type: "note", data: {} }]);
  assert.ok(denied.body);
  assert.equal((denied.body.result as { isError: boolean }).isError, true);
  assert.equal(
    (denied.body.result as { structuredContent: { error: { code: string } } }).structuredContent
      .error.code,
    "SIGNATURE_REQUIRED",
  );
});
