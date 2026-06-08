import type { EventInput } from "@iterate-com/shared/streams/types";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createDefaultCodemodeProviderRegistrations } from "./default-provider-registrations.ts";
import { createExampleCapabilityProviders } from "./example-provider-registrations.ts";
import { createOutboundMcpFromOurClientToolProviderRegistration } from "~/domains/outbound-mcp-client/utils/outbound-mcp-provider-registration.ts";
import {
  EXAMPLE_EGRESS_SECRET_KEY,
  EXAMPLE_EGRESS_SECRET_MATERIAL,
} from "~/domains/secrets/example-secret.ts";
import { createOpenApiProviderRegistration } from "~/rpc-targets/openapi-provider-registration.ts";

export type CodemodeExampleScript = {
  slug: string;
  name: string;
  description?: string;
  code: string;
};

export type CodemodeExampleStack = {
  slug: string;
  name: string;
  description: string;
  events: EventInput[];
  providers: CodemodeProviderInput[];
  scripts: CodemodeExampleScript[];
};

export type CodemodeProviderInput =
  | { type: "example-capabilities" }
  | { type: "iterate-browser-extension" }
  | {
      headers?: Record<string, string>;
      instructions?: string;
      path: string[];
      serverUrl: string;
      type: "outbound-mcp";
    }
  | {
      baseUrl: string;
      headers?: Record<string, string>;
      path: string[];
      specUrl: string;
      type: "openapi";
    };

type CodemodeExampleSeed = Omit<CodemodeExampleStack, "scripts"> & {
  code: string;
};

const codemodeExampleSeeds = [
  {
    slug: "rpc-capability-tour",
    name: "RPC capability tour",
    description:
      "Exercise Workers AI, repo handles, workspace files, subagent handles, promise pipelining, and the project-scoped OS oRPC capability.",
    providers: [{ type: "example-capabilities" }],
    code: `async (ctx) => {
  const ai = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: "Write one line about codemode.",
  });

  const repos = await ctx.repos.list({});

  const workspacePath = \`/rpc-capability-tour-\${Date.now()}.txt\`;
  await ctx.workspace.writeFile(workspacePath, "workspace from codemode\\n");
  const workspace = {
    path: workspacePath,
    text: await ctx.workspace.readFile(workspacePath),
  };

  const agent = await ctx.agents.create().sendMessage({
    message: "hi",
    subPath: "bob",
  });

  const pipelinedAgent = await ctx.agents.create().doThing({
    label: "pipeline",
    value: 21,
  });

  const procedures = await ctx.os.listProcedures();
  const streams = await ctx.os.streams.list({});

  console.log("available oRPC procedures", procedures);
  console.log("project streams", streams);
  return { ai, repos, workspace, agent, pipelinedAgent, procedures, streams };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message: "Registers loopback RPC providers for ai, repos, workspace, agents, and os.",
        },
      },
    ],
  },
  {
    slug: "project-capability-pipelining",
    name: "Project capability pipelining",
    description:
      "Use ctx.env.PROJECT as a Cloudflare RPC service binding, then pipeline through nested project-scoped capabilities.",
    providers: [],
    code: `async (ctx) => {
  const streamPath = \`/codemode/project-capability-\${Date.now()}\`;
  const project = ctx.env.PROJECT;
  const lowerCaseProject = ctx.env.project;

  const firstAppendPromise = project.streams().append({
    streamPath,
    event: {
      type: "events.iterate.com/codemode/example-note",
      payload: { message: "project capability direct stream append" },
    },
  });
  const batchAppendPromise = ctx.env.PROJECT.streams().appendBatch({
    streamPath,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "project capability batch append one" },
      },
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "project capability batch append two" },
      },
    ],
  });
  const aiPromise = ctx.env.PROJECT.ai().run("test-model", {
    prompt: "show that nested project capability RPC works",
  });
  const proceduresPromise = project.orpc().listProcedures();

  const [firstAppend, batchAppends, ai, procedures] = await Promise.all([
    firstAppendPromise,
    batchAppendPromise,
    aiPromise,
    proceduresPromise,
  ]);

  const lowerCaseAppend = await lowerCaseProject.streams().append({
    streamPath,
    event: {
      type: "events.iterate.com/codemode/example-note",
      payload: { message: "project capability lowercase env alias" },
    },
  });
  const [events, state] = await Promise.all([
    project.streams().read({ streamPath, afterOffset: "start" }),
    project.streams().getState({ streamPath }),
  ]);

  return {
    aiModel: ai.model,
    batchAppendCount: batchAppends.length,
    eventMessages: events
      .filter((event) => event.type === "events.iterate.com/codemode/example-note")
      .map((event) => event.payload.message),
    firstAppendOffset: firstAppend.offset,
    lowerCaseAppendOffset: lowerCaseAppend.offset,
    streamInitialized: state != null,
    proceduresIncludeStreams: procedures.includes("streams") && procedures.includes("list"),
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "ctx.env.PROJECT is injected into the dynamic Worker Loader env as a project-scoped WorkerEntrypoint binding.",
        },
      },
    ],
  },
  {
    slug: "openapi-petstore",
    name: "OpenAPI Petstore",
    description:
      "Use a stateless OpenAPI capability, list available operations, then call an operation by operationId.",
    providers: [
      {
        baseUrl: "https://petstore.swagger.io/v2",
        path: ["petstore"],
        specUrl: "https://petstore.swagger.io/v2/swagger.json",
        type: "openapi",
      },
    ],
    code: `async (ctx) => {
  const operations = await ctx.petstore.listOperations();
  console.log("first petstore operations", operations.slice(0, 5));

  const pets = await ctx.petstore.findPetsByStatus({ status: "available" });
  console.log("available pets returned", Array.isArray(pets) ? pets.length : "unknown");

  return {
    operationCount: operations.length,
    firstPet: Array.isArray(pets) ? pets[0] ?? null : pets,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message: "Registers an OpenAPI bridge for https://petstore.swagger.io/v2/swagger.json.",
        },
      },
    ],
  },
  {
    slug: "repo-create-and-git-details",
    name: "Create Repo and inspect Git details",
    description:
      "Use the project-scoped Repos capability to create a Cloudflare Artifacts-backed repo, read it back, and show safe Git clone details.",
    providers: [{ type: "example-capabilities" }],
    code: `async (ctx) => {
  const slug = \`codemode-example-\${Date.now()}\`;

  const created = await ctx.repos.create({ slug }).getInfo();
  const fetched = await ctx.repos.get({ slug }).getInfo();
  const repos = await ctx.repos.list({});

  const redactedCloneCommand = created.git.cloneCommand.replace(
    created.token,
    "<repo-token>",
  );
  const redactedPushCommand = created.git.pushCommand.replace(
    created.token,
    "<repo-token>",
  );

  console.log("created repo", {
    slug: created.slug,
    remote: created.remote,
    defaultBranch: created.defaultBranch,
    tokenExpiresAt: created.tokenExpiresAt,
  });

  return {
    created: {
      slug: created.slug,
      remote: created.remote,
      defaultBranch: created.defaultBranch,
      tokenExpiresAt: created.tokenExpiresAt,
      hasToken: typeof created.token === "string" && created.token.length > 0,
      cloneCommand: redactedCloneCommand,
      pushCommand: redactedPushCommand,
    },
    fetchedMatchesCreated: fetched.remote === created.remote,
    repoCount: repos.length,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Creates one project-scoped Repo through ctx.repos.create({ slug }).getInfo() and redacts the returned token in the script output.",
        },
      },
    ],
  },
  {
    slug: "iterate-config-repo-info",
    name: "Inspect iterate config repo",
    description:
      "Read the project-created iterate-config Repo handle and return the Git access details needed to clone and push.",
    providers: [{ type: "example-capabilities" }],
    code: `async (ctx) => {
  const repo = await ctx.repos.get({ slug: "iterate-config" }).getInfo();

  return {
    slug: repo.slug,
    remote: repo.remote,
    defaultBranch: repo.defaultBranch,
    tokenExpiresAt: repo.tokenExpiresAt,
    cloneCommand: repo.git.cloneCommand,
    pushCommand: repo.git.pushCommand,
    hasToken: typeof repo.token === "string" && repo.token.length > 0,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Reads the project-created iterate-config Repo with ctx.repos.get({ slug }).getInfo().",
        },
      },
    ],
  },
  {
    slug: "iterate-config-workspace-clone-edit-push",
    name: "Clone, edit, and push iterate config",
    description:
      "Use the default workspace provider and the Repos capability to clone the project iterate-config Repo, write a proof file, commit it, and push it back.",
    providers: [{ type: "example-capabilities" }],
    code: `async (ctx) => {
  const repo = await ctx.repos.get({ slug: "iterate-config" }).getInfo();
  const dir = \`/iterate-config-\${Date.now()}\`;
  const fileName = \`workspace-demo-\${Date.now()}.md\`;
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

  await ctx.workspace.writeFile(
    \`\${dir}/\${fileName}\`,
    \`# Workspace codemode proof\\n\\nCreated: \${new Date().toISOString()}\\n\`,
  );
  await ctx.workspace.git.add({ dir, filepath: fileName });
  const commit = await ctx.workspace.git.commit({
    dir,
    message: "Verify workspace codemode push",
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
    status: await ctx.workspace.git.status({ dir }),
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Uses ctx.workspace.git.clone/add/commit/push and ctx.workspace.writeFile against the project iterate-config Repo.",
        },
      },
    ],
  },
  {
    slug: "cloudflare-docs-mcp",
    name: "Cloudflare Docs MCP",
    description: "Use Cloudflare's public documentation MCP server as a normal codemode provider.",
    providers: [
      {
        instructions:
          "Use ctx.mcp.cloudflareDocs to search and inspect Cloudflare documentation. Call listTools() first, then invoke a returned tool name with bracket syntax when it contains punctuation.",
        path: ["mcp", "cloudflareDocs"],
        serverUrl: "https://docs.mcp.cloudflare.com/mcp",
        type: "outbound-mcp",
      },
    ],
    code: `async (ctx) => {
  const tools = await ctx.mcp.cloudflareDocs.listTools();
  console.log("Cloudflare docs MCP tools", tools.tools.map((tool) => tool.name));

  return {
    toolCount: tools.tools.length,
    firstTool: tools.tools[0]?.name ?? null,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message: "Registers Cloudflare's public docs MCP server at ctx.mcp.cloudflareDocs.",
        },
      },
    ],
  },
  {
    slug: "live-connect-openapi-petstore",
    name: "Live-connect OpenAPI Petstore",
    description:
      "Register Swagger Petstore from codemode itself, then immediately call the newly mounted OpenAPI operations.",
    providers: [],
    code: `async (ctx) => {
  const registration = await ctx.codemode.connectToOpenApiServer({
    path: ["live", "petstore"],
    specUrl: "https://petstore.swagger.io/v2/swagger.json",
    baseUrl: "https://petstore.swagger.io/v2",
  });

  const operations = await ctx.live.petstore.listOperations();
  const pets = await ctx.live.petstore.findPetsByStatus({ status: "available" });
  const operationIds = operations.map((operation) => operation.operationId);

  return {
    registeredPath: registration.payload.path,
    operationCount: operations.length,
    hasFindPetsByStatus: operationIds.includes("findPetsByStatus"),
    firstPet: Array.isArray(pets) ? pets[0] ?? null : pets,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Registers Swagger Petstore at ctx.live.petstore via ctx.codemode.connectToOpenApiServer, then calls listOperations and findPetsByStatus.",
        },
      },
    ],
  },
  {
    slug: "live-connect-cloudflare-docs-mcp",
    name: "Live-connect Cloudflare Docs MCP",
    description:
      "Register Cloudflare's public documentation MCP server from codemode itself, then call a real MCP search tool.",
    providers: [],
    code: `async (ctx) => {
  const registration = await ctx.codemode.connectToMcpServer({
    path: ["live", "cloudflareDocs"],
    url: "https://docs.mcp.cloudflare.com/mcp",
    instructions:
      "Use ctx.live.cloudflareDocs.search_cloudflare_documentation({ query }) to search Cloudflare docs.",
  });

  const tools = await ctx.live.cloudflareDocs.listTools();
  const searchResult = await ctx.live.cloudflareDocs.search_cloudflare_documentation({
    query: "Durable Objects alarms",
  });

  return {
    registeredPath: registration.payload.path,
    toolNames: tools.tools.map((tool) => tool.name),
    firstResult: searchResult.content?.[0] ?? searchResult,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Registers Cloudflare Docs MCP at ctx.live.cloudflareDocs via ctx.codemode.connectToMcpServer, then calls listTools and search_cloudflare_documentation.",
        },
      },
    ],
  },
  {
    slug: "stream-append-tool",
    name: "Append to a project stream",
    description: "Use ctx.streams.append as a normal codemode function call.",
    providers: [],
    code: `async (ctx) => {
  const event = await ctx.streams.append({
    event: {
      type: "events.iterate.com/codemode/example-note",
      payload: { message: "appended via ctx.streams.append" },
    },
  });

  console.log("appended event offset", event.offset);
  return { appendedOffset: event.offset };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "streams is a default codemode provider" },
      },
    ],
  },
  {
    slug: "iterate-browser-extension-event-provider",
    name: "Outbound browser extension provider",
    description:
      "Sketch an event-based provider for a browser extension, OpenClaw plugin, or tab runner that can only make outbound requests.",
    providers: [{ type: "iterate-browser-extension" }],
    code: `async (ctx) => {
  const debug = await ctx.codemode.debugInfo({
    source: "codemode script before browser-extension call",
  });
  console.log("session debug", debug);

  const navigation = await ctx.iterateBrowserExtension.navigateToPage({
    url: "https://example.com",
    reason: "prove outbound-only providers can complete codemode function calls",
  });

  return navigation;
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "ctx.codemode.* is always available on the session and does not require provider registration.",
        },
      },
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "ctx.iterateBrowserExtension.navigateToPage is intentionally event-based: a browser extension/OpenClaw-style runner would poll or subscribe, perform local browser work, and append function-call-completed over an outbound fetch.",
        },
      },
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "A Worker-side bridge for that outbound provider can reduce session-started, invoke sessionCapabilityCallable, build a codemode ctx, and call ctx.codemode.debugInfo() or any other session tool while handling the request.",
        },
      },
    ],
  },
  {
    slug: "slow-progress",
    name: "Slow progress stream",
    description: "Emit ten progress log lines with a one second delay between each step.",
    providers: [],
    code: `async (ctx) => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let step = 1; step <= 10; step += 1) {
    console.log(\`running step \${step}/10\`);
    await wait(1000);
  }

  return { ok: true, steps: 10 };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-started",
        payload: { example: "slow-progress" },
      },
    ],
  },
  {
    slug: "javascript-control-flow-mix",
    name: "JavaScript control-flow mix",
    description:
      "Destructure ctx, use timers, Promise.all, Promise.race, try/catch, fetch, console, streams, and oRPC in one script.",
    providers: [{ type: "example-capabilities" }],
    code: `async (ctx) => {
  const { fetch, console, streams, os } = ctx;

  const wait = (ms, value) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms));

  const ticks = [];
  await new Promise((resolve) => {
    const interval = setInterval(() => {
      ticks.push(\`tick-\${ticks.length + 1}\`);
      console.log("interval tick", ticks.length);
      if (ticks.length === 3) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });

  let caughtMessage;
  try {
    throw new Error("expected example failure");
  } catch (error) {
    caughtMessage = error.message;
    console.warn("caught and kept going", caughtMessage);
  }

  const [response, procedures, appended] = await Promise.all([
    fetch("data:application/json,%7B%22hello%22%3A%22codemode%22%7D"),
    os.listProcedures(),
    streams.append({
      event: {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "appended from javascript-control-flow-mix" },
      },
    }),
  ]);

  const raced = await Promise.race([
    wait(1_000, "slow"),
    wait(10, "fast"),
  ]);
  const body = await response.json();
  console.error("error log channel still does not fail the script");

  return {
    appendedOffset: appended.offset,
    body,
    caughtMessage,
    hasStreamsListProcedure: procedures.includes("streams") && procedures.includes("list"),
    raced,
    ticks,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "This is deliberately ordinary async JavaScript using codemode providers through destructured ctx bindings.",
        },
      },
    ],
  },
  {
    slug: "slack-post-message",
    name: "Slack Web API postMessage",
    description: "Use the Slack Web API capability to list channels, pick one, and post a message.",
    providers: [{ type: "example-capabilities" }],
    code: `async (ctx) => {
  const { console, slack } = ctx;

  const channels = await slack.conversations.list({
    exclude_archived: true,
    limit: 50,
    types: "public_channel,private_channel",
  });
  const channel =
    channels.channels.find((item) => item.is_member)?.id ??
    channels.channels[0]?.id;

  if (!channel) {
    throw new Error("Slack conversations.list returned no channels.");
  }

  const message = await slack.chat.postMessage({
    channel,
    text: \`codemode Slack proof \${new Date().toISOString()}\`,
  });

  console.log("posted Slack message", { channel: message.channel, ts: message.ts });
  return {
    channel: message.channel,
    ok: message.ok,
    ts: message.ts,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "ctx.slack.chat.postMessage(args) maps to Slack Web API method chat.postMessage.",
        },
      },
    ],
  },
  {
    slug: "gmail-read-latest-email",
    name: "Read latest Gmail message",
    description:
      "Read the project-scoped Google access token from ctx.secrets, call the Gmail API, and return the latest inbox message.",
    providers: [],
    code: `async (ctx) => {
  const { console, fetch, secrets } = ctx;

  const googleToken = await secrets.getSecret({ key: "google.access_token" });
  console.log("using Google connection", {
    email: googleToken.metadata.email,
    googleUserId: googleToken.metadata.googleUserId,
    scopes: googleToken.metadata.scopes,
  });

  async function gmail(path, init = {}) {
    const response = await fetch(\`https://gmail.googleapis.com/gmail/v1\${path}\`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: \`Bearer \${googleToken.material}\`,
      },
    });

    if (!response.ok) {
      throw new Error(\`Gmail API \${path} returned \${response.status}: \${await response.text()}\`);
    }
    return await response.json();
  }

  const listParams = new URLSearchParams({
    maxResults: "1",
    q: "in:inbox newer_than:30d",
  });
  const messageList = await gmail(\`/users/me/messages?\${listParams}\`);
  const messageId = messageList.messages?.[0]?.id;
  if (!messageId) {
    return { email: googleToken.metadata.email, message: null, reason: "No recent inbox mail." };
  }

  const messageParams = new URLSearchParams({ format: "full" });
  const message = await gmail(\`/users/me/messages/\${messageId}?\${messageParams}\`);
  const headers = Object.fromEntries(
    (message.payload?.headers ?? []).map((header) => [
      String(header.name).toLowerCase(),
      header.value,
    ]),
  );

  function decodeBase64Url(value) {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    return atob(padded);
  }

  function findTextPart(part) {
    if (!part) return null;
    if (part.mimeType === "text/plain" && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) {
      const found = findTextPart(child);
      if (found) return found;
    }
    return null;
  }

  const text = findTextPart(message.payload);
  const result = {
    id: message.id,
    threadId: message.threadId,
    from: headers.from ?? null,
    to: headers.to ?? null,
    subject: headers.subject ?? null,
    date: headers.date ?? null,
    snippet: message.snippet ?? null,
    textPreview: text ? text.slice(0, 2000) : null,
  };

  console.log("latest Gmail message", {
    from: result.from,
    subject: result.subject,
    hasTextPreview: result.textPreview != null,
  });
  return result;
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Requires a project Google connection. Reads ctx.secrets.getSecret({ key: 'google.access_token' }) and calls the Gmail REST API with fetch.",
        },
      },
    ],
  },
  {
    slug: "integration-secrets-and-streams",
    name: "Inspect integration secrets and streams",
    description:
      "List project secrets, read Slack/Google connection metadata, and inspect integration lifecycle/webhook streams.",
    providers: [],
    code: `async (ctx) => {
  const { console, secrets, streams } = ctx;

  const secretSummaries = await secrets.list({});
  const integrationSecrets = secretSummaries.filter((secret) =>
    secret.key === "slack.access_token" || secret.key === "google.access_token",
  );

  const results = {};
  for (const key of ["slack.access_token", "google.access_token"]) {
    try {
      const secret = await secrets.getSecret({ key });
      results[key] = {
        metadata: secret.metadata,
        materialChars: secret.material.length,
      };
    } catch (error) {
      results[key] = { missing: true, message: error.message };
    }
  }

  const [slackLifecycle, googleLifecycle, slackWebhooks] = await Promise.all([
    streams.read({ streamPath: "/integrations/slack", afterOffset: "start" }),
    streams.read({ streamPath: "/integrations/google", afterOffset: "start" }),
    streams.read({ streamPath: "/integrations/slack", afterOffset: "start" }),
  ]);

  console.log("integration secrets", integrationSecrets.map((secret) => secret.key));
  console.log("slack lifecycle events", slackLifecycle.map((event) => event.type));
  console.log("google lifecycle events", googleLifecycle.map((event) => event.type));
  console.log("slack webhook events", slackWebhooks.map((event) => event.type));

  return {
    integrationSecrets,
    secretMetadata: results,
    streamEventCounts: {
      slackLifecycle: slackLifecycle.length,
      googleLifecycle: googleLifecycle.length,
      slackWebhooks: slackWebhooks.length,
    },
    latestSlackWebhook: slackWebhooks.at(-1) ?? null,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Uses default ctx.secrets and ctx.streams providers to inspect project-scoped integration state.",
        },
      },
    ],
  },
  {
    slug: "custom-events",
    name: "Custom event notebook",
    description: "Start with a few scenario events, then add script logs and a result.",
    providers: [],
    code: `async () => {
  console.log("custom events were preloaded before this script ran");

  return {
    note: "script output is recorded on the script-execution-completed event",
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "this event was preloaded before the script ran" },
      },
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "custom events are ordinary event inputs" },
      },
    ],
  },
  {
    slug: "egress-secret-echo",
    name: "Verify egress secret substitution",
    description:
      "Call a public echo server with a getSecret(...) header and verify the Project Durable Object substituted the seeded example secret.",
    providers: [],
    code: `async () => {
  const headerName = "x-iterate-example-secret";
  const response = await fetch("https://httpbin.org/anything", {
    headers: {
      [headerName]: "Bearer getSecret({ key: \\"${EXAMPLE_EGRESS_SECRET_KEY}\\" })",
    },
  });
  if (!response.ok) throw new Error(\`Echo server returned \${response.status}\`);

  const body = await response.json();
  const echoedHeader = body.headers?.[headerName] ?? body.headers?.["X-Iterate-Example-Secret"];
  const echoedValue = Array.isArray(echoedHeader) ? echoedHeader.join(", ") : String(echoedHeader ?? "");
  const expectedValue = "Bearer ${EXAMPLE_EGRESS_SECRET_MATERIAL}";

  if (echoedValue !== expectedValue) {
    throw new Error(\`Expected \${headerName} to echo \${expectedValue}, got \${echoedValue}\`);
  }

  console.log("egress secret substitution worked", { headerName, echoedValue });
  return {
    echoUrl: body.url,
    headerName,
    echoedValue,
    secretKey: "${EXAMPLE_EGRESS_SECRET_KEY}",
    secretReferenceWasSubstituted: true,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "New projects seed an example secret so this script can prove fetch egress header substitution with httpbin.org.",
        },
      },
    ],
  },
  {
    slug: "hacker-news-top-story",
    name: "Summarize a Hacker News story",
    description: "Fetch the current top Hacker News story and log a short summary.",
    providers: [],
    code: `async () => {
  async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(\`\${url} returned \${response.status}\`);
    return await response.json();
  }

  const storyIds = await getJson("https://hacker-news.firebaseio.com/v0/topstories.json");
  const topStory = await getJson(
    \`https://hacker-news.firebaseio.com/v0/item/\${storyIds[0]}.json\`,
  );

  console.log(\`top story: \${topStory.title}\`);
  console.log(\`score: \${topStory.score} by \${topStory.by}\`);
  if (topStory.url) console.log(\`url: \${topStory.url}\`);

  return {
    title: topStory.title,
    score: topStory.score,
    author: topStory.by,
    commentCount: topStory.descendants ?? 0,
    url: topStory.url ?? null,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "calls the public Hacker News Firebase API" },
      },
    ],
  },
  {
    slug: "github-repo-comparison",
    name: "Compare GitHub repositories",
    description: "Call the public GitHub REST API for two repos and log a compact comparison.",
    providers: [],
    code: `async () => {
  async function getRepo(fullName) {
    const response = await fetch(\`https://api.github.com/repos/\${fullName}\`, {
      headers: { "user-agent": "iterate-os-codemode-example" },
    });
    if (!response.ok) throw new Error(\`GitHub returned \${response.status} for \${fullName}\`);
    return await response.json();
  }

  const repos = await Promise.all([
    getRepo("cloudflare/workers-sdk"),
    getRepo("TanStack/router"),
  ]);

  for (const repo of repos) {
    console.log(
      \`\${repo.full_name}: \${repo.stargazers_count} stars, \${repo.open_issues_count} open issues\`,
    );
  }

  const mostStarred = [...repos].sort(
    (left, right) => right.stargazers_count - left.stargazers_count,
  )[0];

  console.log(\`most starred: \${mostStarred.full_name}\`);

  return {
    checkedAt: new Date().toISOString(),
    repos: repos.map((repo) => ({
      name: repo.full_name,
      stars: repo.stargazers_count,
      openIssues: repo.open_issues_count,
      pushedAt: repo.pushed_at,
    })),
    mostStarred: mostStarred.full_name,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "calls the public GitHub REST API without authentication" },
      },
    ],
  },
  {
    slug: "github-and-npm-package-health",
    name: "Combine GitHub and npm signals",
    description: "Fetch package downloads from npm and repository stats from GitHub.",
    providers: [],
    code: `async () => {
  async function getJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(\`\${url} returned \${response.status}\`);
    return await response.json();
  }

  const targets = [
    {
      packageName: "wrangler",
      repoName: "cloudflare/workers-sdk",
    },
    {
      packageName: "@tanstack/react-router",
      repoName: "TanStack/router",
    },
  ];

  const rows = await Promise.all(
    targets.map(async (target) => {
      const encodedPackageName = encodeURIComponent(target.packageName);
      const [downloads, repo] = await Promise.all([
        getJson(\`https://api.npmjs.org/downloads/point/last-week/\${encodedPackageName}\`),
        getJson(\`https://api.github.com/repos/\${target.repoName}\`, {
          headers: { "user-agent": "iterate-os-codemode-example" },
        }),
      ]);

      return {
        packageName: target.packageName,
        repoName: repo.full_name,
        weeklyDownloads: downloads.downloads,
        stars: repo.stargazers_count,
        openIssues: repo.open_issues_count,
      };
    }),
  );

  for (const row of rows) {
    console.log(
      \`\${row.packageName}: \${row.weeklyDownloads} weekly downloads, \${row.stars} GitHub stars\`,
    );
  }

  return {
    checkedAt: new Date().toISOString(),
    rows,
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "combines api.npmjs.org and api.github.com responses" },
      },
    ],
  },
] satisfies CodemodeExampleSeed[];

const codemodeExampleStacks = codemodeExampleSeeds.map(
  ({ code, description, events, name, providers, slug }) =>
    ({
      description,
      events,
      name,
      providers,
      scripts: [
        {
          code,
          description,
          name,
          slug: "default",
        },
      ],
      slug,
    }) satisfies CodemodeExampleStack,
);

export const codemodeExamples = codemodeExampleStacks;

export function findCodemodeExample(slug: string | undefined) {
  if (!slug) return undefined;
  return codemodeExampleStacks.find((example) => example.slug === slug);
}

export function providersForCodemodeExample(input: {
  example: CodemodeExampleStack | undefined;
  projectId: string;
}): ToolProviderRegistration[] {
  return providersForCodemodeProviderInputs({
    projectId: input.projectId,
    providers: input.example?.providers ?? [],
  });
}

export function providersForCodemodeProviderInputs(input: {
  projectId: string;
  providers: CodemodeProviderInput[];
}): ToolProviderRegistration[] {
  return input.providers.flatMap((provider) => {
    switch (provider.type) {
      case "example-capabilities":
        return createExampleCapabilityProviders({ projectId: input.projectId });
      case "iterate-browser-extension":
        return [
          {
            path: ["iterateBrowserExtension"],
            instructions:
              "Hypothetical event-based provider for outbound-only browser automation clients such as a browser extension, OpenClaw plugin, or Chrome tab runner. Use ctx.iterateBrowserExtension.navigateToPage({ url, reason? }). The provider is expected to observe function-call-requested events, perform browser-local work, and append the matching function-call-completed event.",
            invocation: { kind: "event" },
          },
        ];
      case "openapi":
        return [
          createOpenApiProviderRegistration({
            baseUrl: provider.baseUrl,
            headers: provider.headers,
            path: provider.path,
            specUrl: provider.specUrl,
          }),
        ];
      case "outbound-mcp":
        return [
          createOutboundMcpFromOurClientToolProviderRegistration({
            headers: provider.headers,
            instructions: provider.instructions,
            path: provider.path,
            serverUrl: provider.serverUrl,
          }),
        ];
    }
  });
}

export function codemodeProviderRegistrationEvents(
  providers: ToolProviderRegistration[],
): EventInput[] {
  return providers.map((provider) => ({
    idempotencyKey: `codemode:tool-provider-registered:${provider.path.join("/")}`,
    payload: provider,
    type: "events.iterate.com/codemode/tool-provider-registered",
  }));
}

export function defaultCodemodeProviderRegistrationEvents(input: {
  projectId: string;
  streamPath: string;
}): EventInput[] {
  return codemodeProviderRegistrationEvents(createDefaultCodemodeProviderRegistrations(input));
}

export function previewCodemodeScriptExecutionEvent(input: { code: string }): EventInput | null {
  const code = input.code.trim();
  if (code === "") return null;

  return {
    type: "events.iterate.com/codemode/script-execution-requested",
    payload: {
      code,
      scriptExecutionId: "<generated at createSession>",
    },
  };
}
