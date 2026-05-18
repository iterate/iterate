/**
 * Deployment-targeted codemode proof over the project MCP route.
 *
 * This test intentionally does not mock the internet or inject providers. Point
 * it at any running OS project MCP endpoint and it uses the server's static
 * inbound-MCP provider stack through the public MCP tool shape:
 *
 *   OS_E2E_MCP_URL=https://mcp__demo.iterate-preview-2.app/ \
 *   OS_E2E_MCP_BEARER_TOKEN=... \
 *   pnpm test:e2e:codemode-mcp
 *
 * OS_E2E_MCP_BEARER_TOKEN may be a Clerk OAuth access token, a Clerk session
 * token, or an OS admin token. Clerk Testing Tokens are not bearer auth tokens;
 * they only bypass Clerk bot detection for Frontend API requests.
 *
 * If APP_CONFIG_SLACK_BOT_TOKEN is available to the test process, the test
 * discovers the shared Slack e2e channel and proves real
 * ctx.slack.chat.postMessage.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

const maybeMcpUrl = process.env.OS_E2E_MCP_URL?.trim();
const describeIfMcpTarget = maybeMcpUrl ? describe : describe.skip;

describeIfMcpTarget("project MCP exec_js static codemode provider stack", () => {
  it("executes real codemode calls across built-in, RPC, OpenAPI, stream, and optional Slack providers", async () => {
    const mcpUrl = requireMcpUrl();
    const bearerToken = requireBearerToken();
    const slackChannelId = await findSlackE2eChannelId();
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
      },
    });
    const client = new Client({ name: "os-codemode-mcp-provider-stack-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const runCode = tools.tools.find((tool) => tool.name === "exec_js");
      expect(runCode).toBeTruthy();
      expect(JSON.stringify(runCode?.inputSchema)).toContain("code");
      expect(JSON.stringify(runCode?.inputSchema)).not.toContain("providers");

      const result = await client.callTool({
        name: "exec_js",
        arguments: {
          code: buildCodemodeProofScript({ slackChannelId }),
        },
      });

      const text = extractTextContent(result.content).join("\n");
      expect(result.isError, text).not.toBe(true);
      expect(text).toContain("codemode e2e proof started");
      expect(text).toContain("repo callback");

      const proof = parseRunCodeResult(text);
      expect(proof).toMatchObject({
        caughtMessage: "expected e2e throw",
        fetchedPackage: "wrangler",
        openApi: {
          hasFindPetsByStatus: true,
        },
        orpc: {
          sawStreamsList: true,
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
          text: "workspace from MCP e2e\n",
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
  const raw = process.env.OS_E2E_MCP_URL?.trim();
  if (!raw) {
    throw new Error("OS_E2E_MCP_URL is required for the codemode MCP provider-stack e2e.");
  }
  return new URL(raw);
}

function requireBearerToken() {
  const token =
    process.env.OS_E2E_MCP_BEARER_TOKEN?.trim() ??
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ??
    process.env.OS_ADMIN_API_SECRET?.trim() ??
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error(
      "OS_E2E_MCP_BEARER_TOKEN, OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, or APP_CONFIG_ADMIN_API_SECRET is required.",
    );
  }
  return token;
}

async function findSlackE2eChannelId() {
  const token = process.env.APP_CONFIG_SLACK_BOT_TOKEN?.trim();
  if (!token) return null;

  const channels = await listSlackChannels(token);
  const channel = channels.find(
    (candidate) => candidate.name === "slack-agent-e2e-test" && candidate.is_member === true,
  );
  if (!channel) {
    throw new Error(
      "APP_CONFIG_SLACK_BOT_TOKEN is set, but the bot is not a member of #slack-agent-e2e-test.",
    );
  }
  return channel.id;
}

async function listSlackChannels(token: string) {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    url.searchParams.set("types", "public_channel,private_channel");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    const result = (await response.json()) as SlackConversationsListResponse;
    if (!result.ok) {
      throw new Error(`Slack conversations.list failed: ${result.error ?? response.status}`);
    }
    channels.push(...result.channels);
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return channels;
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

  const packageResponse = await fetch("https://registry.npmjs.org/wrangler/latest", {
    headers: { "user-agent": "iterate-os-codemode-e2e" },
  });
  if (!packageResponse.ok) {
    throw new Error(\`npm registry fetch failed with \${packageResponse.status}\`);
  }
  const npmPackage = await packageResponse.json();

  const operations = await integrations.http.catalog.listOperations();
  const pets = await integrations.http.catalog.findPetsByStatus({ status: "available" });

  const aiResult = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: "Return the exact phrase codemode e2e.",
  });

  const repoCallbacks = [];
  const repo = await repos.get({ slug: \`e2e-\${marker}\` }).proofOfConcept({
    message: "repo from MCP e2e",
    callback: async (args) => {
      repoCallbacks.push(args.repoName);
      console.log("repo callback", args.repoName);
    },
  });
  const workspacePath = \`/mcp-e2e-\${marker}.txt\`;
  await workspace.writeFile(workspacePath, "workspace from MCP e2e\\n");
  const workspaceText = await workspace.readFile(workspacePath);

  const explicitAgentHandle = await ctx.agents.create();
  const explicitAgent = await explicitAgentHandle.sendMessage({
    message: "hello explicit handle",
    subPath: "mcp-e2e",
  });
  const pipelinedAgent = await ctx.agents.create().doThing({
    label: "promise-pipeline",
    value: 21,
  });

  const procedures = await os.listProcedures();
  const streamList = await os.streams.list({});

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
    fetchedPackage: npmPackage.name,
    openApi: {
      hasFindPetsByStatus: operations.some((operation) => operation.operationId === "findPetsByStatus"),
      operationCount: operations.length,
      petCount: Array.isArray(pets) ? pets.length : 0,
    },
    orpc: {
      sawStreamsList: procedures.includes("streams") && procedures.includes("list"),
      streamCount: streamList.streams.length,
      typeDefinitionsContainCtxOs: procedures.includes("ctx") && procedures.includes("os"),
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
      path: workspacePath,
      text: workspaceText,
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
    throw new Error(`exec_js did not return a Result block:\n${text}`);
  }
  return JSON.parse(text.slice(index + marker.length).trim()) as {
    ai: { model: string };
    caughtMessage: string;
    fetchedPackage: string;
    openApi: { hasFindPetsByStatus: boolean; petCount: number };
    orpc: { sawStreamsList: boolean; streamCount: number };
    raced: string;
    repo: { callbackCalled: boolean; message: string };
    slack: { skipped: true } | { channel: string; ok: boolean; skipped: false; ts: string };
    stream: { readBackAppendedEvent: boolean };
    subagents: {
      explicit: { message: string; subPath: string };
      pipelined: { doubled: number; label: string; value: number };
    };
    workspace: { path: string; text: string };
  };
}

type SlackChannel = {
  id: string;
  is_member?: boolean;
  name: string;
};

type SlackConversationsListResponse =
  | {
      channels: SlackChannel[];
      ok: true;
      response_metadata?: { next_cursor?: string };
    }
  | {
      error?: string;
      ok: false;
    };
