import type { EventInput } from "@iterate-com/shared/streams/types";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createDefaultCodemodeProviderRegistrations } from "./default-provider-registrations.ts";
import { createExampleCapabilityProviders } from "./example-provider-registrations.ts";
import { createOutboundMcpFromOurClientToolProviderRegistration } from "~/domains/outbound-mcp-client/utils/outbound-mcp-provider-registration.ts";
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
      "Exercise Workers AI, repo/workspace handles, callback passing, subagent handles, promise pipelining, and the project-scoped OS2 oRPC capability.",
    providers: [{ type: "example-capabilities" }],
    code: `async (ctx) => {
  const ai = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: "Write one line about codemode.",
  });

  const repos = await ctx.repos.list({});

  const workspace = await ctx.workspace.proofOfConcept({
    callback: async (args) => console.log("workspace callback", args.workspaceName),
  });

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
  const debug = await ctx.__codemode.debugInfo({
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
            "ctx.__codemode.* is always available on the session and does not require provider registration.",
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
            "A Worker-side bridge for that outbound provider can reduce session-started, invoke sessionCapabilityCallable, build a codemode ctx, and call ctx.__codemode.debugInfo() or any other session tool while handling the request.",
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
      headers: { "user-agent": "iterate-os2-codemode-example" },
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
          headers: { "user-agent": "iterate-os2-codemode-example" },
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

export const codemodeExampleStacks = codemodeExampleSeeds.map(
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
