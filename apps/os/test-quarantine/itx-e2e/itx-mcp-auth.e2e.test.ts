// QUARANTINED (itx-v4 cutover) — origin: apps/os/src/itx/e2e/itx-mcp-auth.e2e.test.ts
// Covered: authenticated remote MCP via secret-substituted egress against
// Cloudflare's real MCP server, including placeholder-never-material negative
// controls.
// Why quarantined: legacy itx surface removed in the itx-v4 cutover; superseded by
// apps/os/e2e/engine/* engine suites ("MCP built-in connects directly and mounts
// as a described capability" with a mock authenticated MCP fixture).

// Authenticated MCP via secret-substituted egress, proven against a REAL
// third-party server: Cloudflare's remote MCP server at
// https://bindings.mcp.cloudflare.com/mcp (streamable HTTP; 401 without
// `Authorization: Bearer <api token>`, full MCP with it).
//
// The shape under test is the McpClient docstring's promise end to end:
//   - the credential lives as a PROJECT SECRET (a D1 row, written via the
//     admin REST surface)
//   - the capability ADDRESS carries only a getSecret(...) placeholder
//   - substitution happens server-side in the EgressPipe on the egress path
//   - neither describe() nor the record ever contains the material
//
// Requires CLOUDFLARE_API_TOKEN in the environment — present under
// `doppler run --config prd|preview_N --project os` (the same token alchemy
// deploys with). Absent → the test skips, never fails.

import { expect, test } from "vitest";
import { connectGlobal, registerCreatedProjectCleanup } from "./e2e-env.ts";

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
const MCP_SERVER_URL = "https://bindings.mcp.cloudflare.com/mcp";
const PUBLIC_MCP_SERVER_URL = "https://docs.mcp.cloudflare.com/mcp";
const SECRET_KEY = "CLOUDFLARE_API_TOKEN";
const PLACEHOLDER = `Bearer getSecret({ key: "${SECRET_KEY}" })`;

const createdProjectIds = registerCreatedProjectCleanup();

test(
  "public MCP: an unauthenticated server via McpClient (the mcp-client catalogue example)",
  { timeout: 90_000 },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({
      slug: `itx-mcp-pub-${crypto.randomUUID().slice(0, 8)}`,
    })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);

    await projectItx.provideCapability({
      name: "cfdocs",
      instructions: "Cloudflare's documentation MCP server. Call listTools() first.",
      capability: {
        entrypoint: "McpClient",
        props: { serverUrl: PUBLIC_MCP_SERVER_URL },
        type: "rpc",
        worker: { type: "loopback" },
      },
    });

    const handle = projectItx as never as Record<string, any>;
    const listed = (await handle.cfdocs.listTools()) as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toContain("search_cloudflare_documentation");
    const answer = await handle.cfdocs.search_cloudflare_documentation({
      query: "durable objects",
    });
    expect(
      String(typeof answer === "string" ? answer : JSON.stringify(answer)).length,
    ).toBeGreaterThan(0);
  },
);

test.skipIf(!CLOUDFLARE_API_TOKEN)(
  "authenticated MCP: the credential is a project secret, substituted on egress, invisible everywhere else",
  { timeout: 90_000 },
  async () => {
    using itx = connectGlobal();
    const project = (await itx.projects.create({
      slug: `itx-mcp-auth-${crypto.randomUUID().slice(0, 8)}`,
    })) as { id: string };
    createdProjectIds.push(project.id);
    using projectItx = await itx.projects.get(project.id);

    // (1) The secret enters the platform exactly once, through the project
    // secrets surface — from here on only the KEY travels. Project-scoped itx
    // is the way to interact with secrets (the old REST upsert is gone).
    const secrets = projectItx as never as Record<string, any>;
    await secrets.secrets.setSecret({ key: SECRET_KEY, material: CLOUDFLARE_API_TOKEN });

    // (2) The capability address carries the PLACEHOLDER, never the material.
    await projectItx.provideCapability({
      path: ["mcp", "cloudflare"],
      capability: {
        entrypoint: "McpClient",
        props: {
          headers: { authorization: PLACEHOLDER },
          serverUrl: MCP_SERVER_URL,
        },
        type: "rpc",
        worker: { type: "loopback" },
      },
      instructions: "Cloudflare's MCP server, authenticated via a project secret.",
    });

    // (3) listTools succeeds — which can only happen if the EgressPipe
    // substituted the real token (the server 401s without it; see the curl
    // probes in this file's header).
    const handle = projectItx as never as Record<string, any>;
    const listed = (await handle.mcp.cloudflare.listTools()) as { tools: { name: string }[] };
    expect(Array.isArray(listed.tools)).toBe(true);
    expect(listed.tools.length).toBeGreaterThan(0);

    // (4) One read-only tool call asserting a REAL result. The docs-search
    // tool is account-independent and stable; any non-empty answer proves the
    // authenticated round trip end to end.
    expect(listed.tools.map((tool) => tool.name)).toContain("search_cloudflare_documentation");
    const result = await handle.mcp.cloudflare.search_cloudflare_documentation({
      query: "durable objects",
    });
    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    expect(resultText.length).toBeGreaterThan(0);
    expect(resultText.toLowerCase()).toContain("durable");
    expect(resultText).not.toContain(CLOUDFLARE_API_TOKEN);

    // (5) Negative control: the secret material exists ONLY in the egress
    // pipe. describe() (the agent-facing view) and the stream (the durable
    // record, address included) both carry the placeholder, never the token.
    const description = await projectItx.describe();
    const describedJson = JSON.stringify(description);
    expect(describedJson).toContain("mcp.cloudflare");
    expect(describedJson).not.toContain(CLOUDFLARE_API_TOKEN);

    const journal = (await projectItx.streams.get("/").getEvents()) as Array<{
      payload: Record<string, unknown>;
      type: string;
    }>;
    const provided = journal.find(
      (event) =>
        event.type === "events.iterate.com/itx/capability-provided" &&
        Array.isArray(event.payload.path) &&
        (event.payload.path as string[]).join(".") === "mcp.cloudflare",
    );
    expect(provided).toBeDefined();
    const journaledAddress = provided!.payload.address as {
      props: { headers: Record<string, string> };
    };
    expect(journaledAddress.props.headers.authorization).toBe(PLACEHOLDER);
    expect(JSON.stringify(journal)).not.toContain(CLOUDFLARE_API_TOKEN);
  },
);
