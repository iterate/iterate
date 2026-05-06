/**
 * Deployment-targeted codemode proof over the project MCP route.
 *
 * This test intentionally does not mock the internet or inject providers. Point
 * it at any running OS2 project MCP endpoint and it uses the server's static
 * inbound-MCP provider stack through the public MCP tool shape:
 *
 *   OS2_E2E_MCP_URL=https://mcp__demo.iterate-preview-2.app/ \
 *   OS2_E2E_MCP_BEARER_TOKEN=... \
 *   pnpm --dir apps/os2 test:e2e:codemode-mcp
 *
 * Optional:
 *   OS2_E2E_SLACK_CHANNEL_ID=C123  # proves real ctx.slack.chat.postMessage
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

const maybeMcpUrl = process.env.OS2_E2E_MCP_URL?.trim();
const describeIfMcpTarget = maybeMcpUrl ? describe : describe.skip;

describeIfMcpTarget("project MCP run_code static codemode provider stack", () => {
  it("executes real codemode calls across built-in, RPC, OpenAPI, stream, and optional Slack providers", async () => {
    const mcpUrl = requireMcpUrl();
    const bearerToken = requireBearerToken();
    const slackChannelId = process.env.OS2_E2E_SLACK_CHANNEL_ID?.trim() || null;
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
      },
    });
    const client = new Client({ name: "os2-codemode-mcp-provider-stack-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const runCode = tools.tools.find((tool) => tool.name === "run_code");
      expect(runCode).toBeTruthy();
      expect(JSON.stringify(runCode?.inputSchema)).toContain("code");
      expect(JSON.stringify(runCode?.inputSchema)).not.toContain("providers");

      const result = await client.callTool({
        name: "run_code",
        arguments: {
          code: buildCodemodeProofScript({ slackChannelId }),
        },
      });

      const text = extractTextContent(result.content).join("\n");
      expect(result.isError, text).not.toBe(true);
      expect(text).toContain("codemode e2e proof started");
      expect(text).toContain("repo callback");
      expect(text).toContain("workspace callback");

      const proof = parseRunCodeResult(text);
      expect(proof).toMatchObject({
        caughtMessage: "expected e2e throw",
        fetchedRepo: "cloudflare/workers-sdk",
        openApi: {
          hasFindPetsByStatus: true,
        },
        orpc: {
          logDemoOk: true,
          sawLogDemoProcedure: true,
        },
        repo: {
          callbackCalled: true,
          message: "repo from MCP e2e",
        },
        stream: {
          readBackAppendedEvent: true,
        },
        subagents: {
          explicit: {
            message: "hello explicit handle",
            subPath: "mcp-e2e",
          },
          pipelined: {
            doubled: 42,
            label: "promise-pipeline",
            value: 21,
          },
        },
        workspace: {
          callbackCalled: true,
          message: "workspace from MCP e2e",
        },
      });
      expect(proof.ai.model).toBe("@cf/meta/llama-3.1-8b-instruct");
      expect(proof.openApi.petCount).toBeGreaterThanOrEqual(0);
      expect(proof.raced).toBe("fast");

      if (slackChannelId) {
        expect(proof.slack.skipped).toBe(false);
        expect(proof.slack).toMatchObject({
          channel: slackChannelId,
          ok: true,
          skipped: false,
        });
        if (proof.slack.skipped === false) {
          expect(proof.slack.ts).toEqual(expect.any(String));
        }
      } else {
        expect(proof.slack).toEqual({ skipped: true });
      }
    } finally {
      // Do not force MCP DELETE in the deployed preview proof. Cloudflare's
      // agents package currently implements DELETE by calling Agent.destroy(),
      // which intentionally aborts the Durable Object with "destroyed" after
      // cleanup. That is valid session teardown, but Workers observability records
      // it as an error-level span, which makes this smoke proof look unhealthy.
      await client.close();
    }
  });
});

function requireMcpUrl() {
  const raw = process.env.OS2_E2E_MCP_URL?.trim();
  if (!raw) {
    throw new Error("OS2_E2E_MCP_URL is required for the codemode MCP provider-stack e2e.");
  }
  return new URL(raw);
}

function requireBearerToken() {
  const token =
    process.env.OS2_E2E_MCP_BEARER_TOKEN?.trim() ??
    process.env.OS2_E2E_ADMIN_API_SECRET?.trim() ??
    process.env.OS2_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error(
      "OS2_E2E_MCP_BEARER_TOKEN, OS2_E2E_ADMIN_API_SECRET, or OS2_ADMIN_API_SECRET is required.",
    );
  }
  return token;
}

function buildCodemodeProofScript(input: { slackChannelId: string | null }) {
  const slackChannelLiteral = JSON.stringify(input.slackChannelId);
  return `async (ctx) => {
  const { ai, console, fetch, integrations, os, repos, streams, workspace } = ctx;
  const marker = crypto.randomUUID();
  const wait = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  console.log("codemode e2e proof started", marker);

  let caughtMessage = null;
  try {
    throw new Error("expected e2e throw");
  } catch (error) {
    caughtMessage = error.message;
    console.warn("caught expected error", caughtMessage);
  }

  const githubResponse = await fetch("https://api.github.com/repos/cloudflare/workers-sdk", {
    headers: { "user-agent": "iterate-os2-codemode-e2e" },
  });
  if (!githubResponse.ok) {
    throw new Error(\`GitHub fetch failed with \${githubResponse.status}\`);
  }
  const githubRepo = await githubResponse.json();

  const operations = await integrations.http.catalog.listOperations();
  const pets = await integrations.http.catalog.findPetsByStatus({ status: "available" });

  const aiResult = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: "Return the exact phrase codemode e2e.",
  });

  const repoCallbacks = [];
  const workspaceCallbacks = [];
  const repo = await repos.get({ slug: \`e2e-\${marker}\` }).proofOfConcept({
    message: "repo from MCP e2e",
    callback: async (args) => {
      repoCallbacks.push(args.repoName);
      console.log("repo callback", args.repoName);
    },
  });
  const workspaceResult = await workspace.proofOfConcept({
    message: "workspace from MCP e2e",
    callback: async (args) => {
      workspaceCallbacks.push(args.workspaceName);
      console.log("workspace callback", args.workspaceName);
    },
  });

  const explicitAgentHandle = await ctx.createSubagent();
  const explicitAgent = await explicitAgentHandle.sendMessage({
    message: "hello explicit handle",
    subPath: "mcp-e2e",
  });
  const pipelinedAgent = await ctx.makeSubagent().doThing({
    label: "promise-pipeline",
    value: 21,
  });

  const procedures = await os.listProcedures();
  const logDemo = await os.test.logDemo({ label: "mcp-provider-stack-e2e" });

  const appended = await streams.append({
    event: {
      type: "events.iterate.com/codemode/e2e-proof",
      payload: { marker },
    },
  });
  const readBack = await streams.read({
    afterOffset: appended.offset > 1 ? appended.offset - 1 : "start",
  });

  const slackChannelId = ${slackChannelLiteral};
  const slack = slackChannelId
    ? await ctx.slack.chat.postMessage({
        channel: slackChannelId,
        text: \`codemode MCP e2e proof \${marker}\`,
      })
    : { skipped: true };

  const raced = await Promise.race([
    wait(1000, "slow"),
    wait(10, "fast"),
  ]);

  return {
    ai: {
      model: aiResult.model ?? "@cf/meta/llama-3.1-8b-instruct",
      hasResponse: typeof aiResult.response === "string" || typeof aiResult.result === "string",
    },
    caughtMessage,
    fetchedRepo: githubRepo.full_name,
    openApi: {
      hasFindPetsByStatus: operations.some((operation) => operation.operationId === "findPetsByStatus"),
      operationCount: operations.length,
      petCount: Array.isArray(pets) ? pets.length : 0,
    },
    orpc: {
      logDemoOk: logDemo.ok,
      sawLogDemoProcedure: procedures.procedures.some((procedure) => procedure.path === "test.logDemo"),
      typeDefinitionsContainCtxOs: procedures.typeDefinitions.includes("ctx") && procedures.typeDefinitions.includes("os"),
    },
    raced,
    repo: {
      callbackCalled: repoCallbacks.length > 0,
      message: repo.message,
      repoName: repo.repoName,
    },
    slack: slackChannelId
      ? {
          channel: slack.channel,
          ok: slack.ok,
          skipped: false,
          ts: slack.ts,
        }
      : slack,
    stream: {
      appendedOffset: appended.offset,
      readBackAppendedEvent: readBack.some((event) => event.offset === appended.offset && event.payload?.marker === marker),
    },
    subagents: {
      explicit: explicitAgent,
      pipelined: pipelinedAgent,
    },
    workspace: {
      callbackCalled: workspaceCallbacks.length > 0,
      message: workspaceResult.message,
      workspaceName: workspaceResult.workspaceName,
    },
  };
}`;
}

function extractTextContent(content: unknown) {
  if (!Array.isArray(content)) return [];

  return content.flatMap((item) =>
    item != null &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [item.text]
      : [],
  );
}

function parseRunCodeResult(text: string) {
  const marker = "Result:";
  const index = text.lastIndexOf(marker);
  if (index === -1) {
    throw new Error(`run_code did not return a Result block:\n${text}`);
  }
  return JSON.parse(text.slice(index + marker.length).trim()) as {
    ai: { model: string };
    caughtMessage: string;
    fetchedRepo: string;
    openApi: { hasFindPetsByStatus: boolean; petCount: number };
    orpc: { logDemoOk: boolean; sawLogDemoProcedure: boolean };
    raced: string;
    repo: { callbackCalled: boolean; message: string };
    slack: { skipped: true } | { channel: string; ok: boolean; skipped: false; ts: string };
    stream: { readBackAppendedEvent: boolean };
    subagents: {
      explicit: { message: string; subPath: string };
      pipelined: { doubled: number; label: string; value: number };
    };
    workspace: { callbackCalled: boolean; message: string };
  };
}
