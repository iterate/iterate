import type { EventInput } from "@iterate-com/shared/streams/types";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createExampleCapabilityProviders } from "./example-provider-registrations.ts";
import { createOpenApiProviderRegistration } from "~/rpc-targets/openapi-provider-registration.ts";

export type CodemodeExample = {
  slug: string;
  name: string;
  description: string;
  code: string;
  events: EventInput[];
  providerSet?: "example-capabilities" | "openapi-petstore";
};

export const codemodeExamples = [
  {
    slug: "rpc-capability-tour",
    name: "RPC capability tour",
    description:
      "Exercise Workers AI, repo/workspace handles, callback passing, root unary subagent handles, promise pipelining, and a toy oRPC capability.",
    providerSet: "example-capabilities",
    code: `async (ctx) => {
  const ai = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: "Write one line about codemode.",
  });

  const repo = await ctx.repos.get({ slug: "web" }).proofOfConcept({
    callback: async (args) => console.log("repo callback", args.repoName),
  });

  const workspace = await ctx.workspace.proofOfConcept({
    callback: async (args) => console.log("workspace callback", args.workspaceName),
  });

  const agent = await ctx.createSubagent().sendMessage({
    message: "hi",
    subPath: "bob",
  });

  const pipelinedAgent = await ctx.makeSubagent().doThing({
    label: "pipeline",
    value: 21,
  });

  const procedures = await ctx.os.listProcedures();
  const orpc = await ctx.os.test.logDemo({ label: "codemode" });

  console.log("available oRPC procedures", procedures);
  return { ai, repo, workspace, agent, pipelinedAgent, procedures, orpc };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: {
          message:
            "Registers loopback RPC providers for ai, repos, workspace, createSubagent, makeSubagent, and os.",
        },
      },
    ],
  },
  {
    slug: "openapi-petstore",
    name: "OpenAPI Petstore",
    description:
      "Use a stateless OpenAPI capability, list available operations, then call an operation by operationId.",
    providerSet: "openapi-petstore",
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
    slug: "stream-append-tool",
    name: "Append to a project stream",
    description: "Use ctx.streams.append as a normal codemode function call.",
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
    slug: "slow-progress",
    name: "Slow progress stream",
    description: "Emit ten progress log lines with a one second delay between each step.",
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
    providerSet: "example-capabilities",
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
    procedureCount: procedures.procedures.length,
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
    description:
      "Use the Slack Web API capability. It expects a bot token binding on the worker and a real channel id.",
    providerSet: "example-capabilities",
    code: `async (ctx) => {
  const { console, slack } = ctx;
  const channel = "REPLACE_WITH_CHANNEL_ID";

  if (channel === "REPLACE_WITH_CHANNEL_ID") {
    throw new Error("Set channel to a Slack channel id before running this example.");
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
] satisfies CodemodeExample[];

export function findCodemodeExample(slug: string | undefined) {
  if (!slug) return undefined;
  return codemodeExamples.find((example) => example.slug === slug);
}

export function providersForCodemodeExample(input: {
  example: CodemodeExample | undefined;
  projectId: string;
}): ToolProviderRegistration[] {
  switch (input.example?.providerSet) {
    case "example-capabilities":
      return createExampleCapabilityProviders({ projectId: input.projectId });
    case "openapi-petstore":
      return [
        createOpenApiProviderRegistration({
          path: ["petstore"],
          specUrl: "https://petstore.swagger.io/v2/swagger.json",
          baseUrl: "https://petstore.swagger.io/v2",
        }),
      ];
    default:
      return [];
  }
}
