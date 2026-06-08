#!/usr/bin/env npx tsx

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_BASE_URL = "https://os.iterate-preview-2.com";

type Project = {
  id: string;
  slug: string;
};

async function main() {
  const baseUrl = new URL(process.env.APP_CONFIG_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const adminApiSecret = requireAdminApiSecret();
  const project = await createProject({
    adminApiSecret,
    baseUrl,
    slug: readProjectSlug(),
  });
  const mcpUrl = projectMcpUrlFor({ baseUrl, project });
  const result = await runWorkspaceCodemodeProof({
    bearerToken: adminApiSecret,
    mcpUrl,
  });

  console.info(
    JSON.stringify(
      {
        baseUrl: baseUrl.toString(),
        mcpUrl: mcpUrl.toString(),
        project,
        result,
      },
      null,
      2,
    ),
  );
}

function requireAdminApiSecret() {
  const token =
    process.env.OS_E2E_MCP_BEARER_TOKEN?.trim() ||
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error(
      "APP_CONFIG_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, OS_E2E_ADMIN_API_SECRET, or OS_E2E_MCP_BEARER_TOKEN is required.",
    );
  }
  return token;
}

function readProjectSlug() {
  const explicit = process.env.OS_WORKSPACE_CODEMODE_PROJECT_SLUG?.trim();
  if (explicit) return explicit;

  return `workspace-codemode-example-${Date.now()}`;
}

async function createProject(input: { adminApiSecret: string; baseUrl: URL; slug: string }) {
  const response = await fetch(new URL("/api/projects", input.baseUrl), {
    body: JSON.stringify({
      slug: input.slug,
    }),
    headers: {
      authorization: `Bearer ${input.adminApiSecret}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (response.status === 409) {
    return await fetchProjectBySlug(input);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to create preview project ${input.slug}: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()) as Project;
}

async function fetchProjectBySlug(input: { adminApiSecret: string; baseUrl: URL; slug: string }) {
  const response = await fetch(new URL(`/api/projects/by-slug/${input.slug}`, input.baseUrl), {
    headers: {
      authorization: `Bearer ${input.adminApiSecret}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch preview project ${input.slug}: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()) as Project;
}

function projectMcpUrlFor(input: { baseUrl: URL; project: Project }) {
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(input.baseUrl.hostname);
  if (previewMatch) {
    return new URL(`https://mcp.iterate-preview-${previewMatch[1]}.com/`);
  }

  if (input.baseUrl.hostname === "os.iterate.com") {
    return new URL("https://mcp.iterate.com/");
  }

  throw new Error(
    `Cannot derive the MCP URL from ${input.baseUrl}. Set APP_CONFIG_MCP__BASE_URL or pass a known OS deployment.`,
  );
}

async function runWorkspaceCodemodeProof(input: { bearerToken: string; mcpUrl: URL }) {
  const transport = new StreamableHTTPClientTransport(input.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
      },
    },
  });
  const client = new Client({
    name: "os-workspace-codemode-preview-example",
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
  return `async (ctx) => {
  const repo = await ctx.repos.get({ slug: "iterate-config" }).getInfo();
  const dir = \`/workspace-preview-example-\${Date.now()}\`;
  const fileName = \`workspace-preview-example-\${Date.now()}.md\`;
  const password = repo.token.includes("?expires=")
    ? repo.token.split("?expires=")[0]
    : repo.token;
  const auth = { username: "x", password };

  await ctx.workspace.git.clone({
    url: repo.remote,
    dir,
    branch: repo.defaultBranch,
    depth: 1,
    ...auth,
  });

  const filePath = \`\${dir}/\${fileName}\`;
  await ctx.workspace.writeFile(
    filePath,
    \`# Workspace codemode preview example\\n\\nCreated: \${new Date().toISOString()}\\n\`,
  );
  const readBack = await ctx.workspace.readFile(filePath);
  await ctx.workspace.git.add({ dir, filepath: fileName });
  const commit = await ctx.workspace.git.commit({
    dir,
    message: "Verify workspace codemode preview example",
    author: { name: "Codemode", email: "codemode@iterate.com" },
  });
  const pushed = await ctx.workspace.git.push({
    dir,
    remote: "origin",
    ref: repo.defaultBranch,
    ...auth,
  });

  return {
    commit,
    fileName,
    pushed,
    readBack,
    repo: {
      slug: repo.slug,
      remote: repo.remote,
      defaultBranch: repo.defaultBranch,
    },
    status: await ctx.workspace.git.status({ dir }),
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
