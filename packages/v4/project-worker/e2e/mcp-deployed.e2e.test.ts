// Deployed-only OAuth PKCE + MCP proof. The callback is parsed, never followed.
import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { workerUrl } from "./support/client.ts";

test.skipIf(!process.env.WORKER_BASE_URL || process.env.WORKER_DEMO_LOGIN !== "1")(
  "deployed PKCE grant reaches only its synthetic project MCP",
  async () => {
    const project = `prj_mcp_${Date.now().toString(36)}`;
    const redirectUri = "http://localhost:9876/callback";
    const registered = await fetch(workerUrl("/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "v4 deployed e2e",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const verifier = "v4-deployed-pkce-verifier-with-sufficient-length";
    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
    const query = new URLSearchParams({
      client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "project",
      resource: workerUrl("/mcp"),
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const approved = await fetch(workerUrl(`/authorize?${query}`), {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: new URL(workerUrl("/")).origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ project }),
    });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.origin).toBe("http://localhost:9876");
    const token = await fetch(workerUrl("/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        redirect_uri: redirectUri,
        code: callback.searchParams.get("code")!,
        code_verifier: verifier,
        grant_type: "authorization_code",
        resource: workerUrl("/mcp"),
      }),
    });
    const { access_token } = (await token.json()) as { access_token: string };
    expect(
      (
        await fetch(workerUrl(`/mcp?project=${project}_foreign`), {
          headers: { authorization: `Bearer ${access_token}` },
        })
      ).status,
    ).toBe(403);
    const mcp = async (id: number, method: string, params?: unknown) =>
      fetch(workerUrl(`/mcp?project=${project}`), {
        method: "POST",
        headers: {
          authorization: `Bearer ${access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      });
    expect(
      (
        await mcp(1, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "v4-deployed-e2e", version: "1" },
        })
      ).status,
    ).toBe(200);
    const tools = (await (await mcp(2, "tools/list", {})).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(tools.result.tools.some((tool) => tool.name === "itx.invoke")).toBe(true);
    const key = "deployed-mcp-proof";
    const write = (await (
      await mcp(3, "tools/call", {
        name: "itx.invoke",
        arguments: { expression: "itx.kv.put", args: [key, "scoped-value"] },
      })
    ).json()) as { result: { isError?: boolean } };
    expect(write.result.isError).not.toBe(true);
    const read = (await (
      await mcp(4, "tools/call", {
        name: "itx.invoke",
        arguments: { expression: "itx.kv.get", args: [key] },
      })
    ).json()) as { result: { structuredContent?: unknown } };
    expect(read.result.structuredContent).toEqual({ result: "scoped-value" });
  },
);
