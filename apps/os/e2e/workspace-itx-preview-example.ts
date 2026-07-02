#!/usr/bin/env npx tsx

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAdminOsItx } from "./test-support/os-client.ts";

const DEFAULT_BASE_URL = "https://os.iterate-preview-2.com";

async function main() {
  const baseUrl = new URL(process.env.APP_CONFIG_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const adminApiSecret = requireAdminApiSecret();
  const slug = readProjectSlug();
  await ensureProject({ baseUrl, slug });
  const mcpUrl = projectMcpUrlFor({ baseUrl });
  const result = await runWorkspaceCodemodeProof({
    bearerToken: adminApiSecret,
    mcpUrl,
    projectSlug: slug,
  });

  console.info(
    JSON.stringify(
      {
        baseUrl: baseUrl.toString(),
        mcpUrl: mcpUrl.toString(),
        project: { slug },
        result,
      },
      null,
      2,
    ),
  );
}

function requireAdminApiSecret() {
  const token = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");
  }
  return token;
}

function readProjectSlug() {
  const explicit = process.env.OS_E2E_CODEMODE_PROJECT_SLUG?.trim();
  if (explicit) return explicit;

  return `workspace-itx-example-${Date.now()}`;
}

/**
 * Ensure the project exists via project-scoped itx (the REST `/api/projects`
 * route is gone with oRPC). We only need it to EXIST — the MCP URL is derived
 * from the deployment host, not the project row — so a stable-slug CONFLICT
 * from an earlier run is success.
 */
async function ensureProject(input: { baseUrl: URL; slug: string }) {
  using itx = createAdminOsItx({ baseUrl: input.baseUrl.toString() });
  try {
    await itx.projects.create({ slug: input.slug });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code !== "CONFLICT" && !/already exists/i.test(message)) {
      throw error;
    }
  }
}

function projectMcpUrlFor(input: { baseUrl: URL }) {
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(input.baseUrl.hostname);
  if (previewMatch) {
    return new URL(`https://mcp.iterate-preview-${previewMatch[1]}.com`);
  }

  if (input.baseUrl.hostname === "os.iterate.com") {
    return new URL("https://mcp.iterate.com");
  }

  throw new Error(
    `Cannot derive the MCP URL from ${input.baseUrl}. Set APP_CONFIG_MCP__BASE_URL or pass a known OS deployment.`,
  );
}

async function runWorkspaceCodemodeProof(input: {
  bearerToken: string;
  mcpUrl: URL;
  projectSlug: string;
}) {
  const transport = new StreamableHTTPClientTransport(input.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
      },
    },
  });
  const client = new Client({
    name: "os-workspace-itx-preview-example",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "exec_js")) {
      throw new Error(`MCP endpoint did not expose exec_js: ${JSON.stringify(tools.tools)}`);
    }

    const result = await client.callTool({
      name: "exec_js",
      arguments: {
        code: workspaceCodemodeScript(),
        // The admin lane serves every project, so exec_js requires an explicit
        // project slug (resolved through the KV project directory).
        project: input.projectSlug,
      },
    });
    const text = extractTextContent(result.content).join("\n");
    if (result.isError === true) {
      throw new Error(`exec_js returned an error:\n${text}`);
    }

    return parseRunCodeResult(text);
  } finally {
    await client.close();
  }
}

function workspaceCodemodeScript() {
  // itx-v4 cutover: this used to drive the workspaces domain (gitClone /
  // writeFile / gitCommit / gitPush against a checkout). The workspaces
  // domain is gone — the itx repo capability commits directly to the
  // project repo — so the proof is now: MCP exec_js -> repo.commitFiles,
  // then an identical second commit whose noChanges: true is the read-back
  // (commits are content-addressed and idempotent).
  return `async (itx) => {
  const fileName = "workspace-preview-example-" + Date.now() + ".md";
  const content = "# Workspace itx preview example\\n\\nCreated: " + new Date().toISOString() + "\\n";

  const commit = await itx.repo.commitFiles({
    message: "Verify workspace codemode preview example",
    changes: [{ path: fileName, content }],
  });

  const readBack = await itx.repo.commitFiles({
    message: "Read-back probe (identical tree must be a no-op)",
    changes: [{ path: fileName, content }],
  });

  return {
    commit: {
      branch: commit.branch,
      changedPaths: commit.changedPaths,
      noChanges: commit.noChanges,
    },
    fileName,
    readBackNoChanges: readBack.noChanges,
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
  return JSON.parse(text.slice(index + marker.length).trim()) as unknown;
}

await main();
