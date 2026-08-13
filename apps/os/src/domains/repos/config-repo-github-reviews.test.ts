import { describe, expect, it, vi } from "vitest";
import type { GithubRepoLink, Project, StreamEvent, StreamEventInput } from "iterate/sdk";
import {
  githubAiLinterEventTypes,
  handleGithubPullRequestWebhook as handleGithubPullRequestWebhookWithPolicy,
} from "iterate/starter-apps/github-ai-linter/worker";

const testAndSpecFileGlobs = [
  "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "!**/{__tests__,test,tests,spec,specs}/**",
];
const rules = {
  "structure/no-small-single-use-helper": {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}", ...testAndSpecFileGlobs],
    invariant:
      "Do not introduce a small helper used only once when keeping the logic at its call site would be clearer.",
    severity: "error" as const,
  },
  "typescript/no-inferable-type-annotation": {
    files: ["**/*.{ts,tsx,mts,cts}", ...testAndSpecFileGlobs],
    invariant: "Do not declare a type annotation that TypeScript can infer from the value.",
    severity: "error" as const,
  },
  "typescript/explain-type-cast": {
    files: ["**/*.{ts,tsx,mts,cts}", ...testAndSpecFileGlobs],
    invariant:
      "Every type cast must have a nearby explanation of why it is safe and cannot reasonably be avoided.",
    severity: "error" as const,
  },
};
const config = {
  policyVersion: "2",
  rules: { paths: Object.keys(rules).map((id) => `rules/${id}.md`), repoPath: "/repos/config" },
};
const policy = {
  config,
  loadRules: async () => ({ commitOid: "rules-abc", rules }),
};
const ruleFiles = Object.fromEntries(
  Object.entries(rules).map(([id, rule]) => [
    `rules/${id}.md`,
    [
      "---",
      `id: ${id}`,
      `files: ${JSON.stringify(rule.files)}`,
      `severity: ${rule.severity}`,
      "---",
      rule.invariant,
    ].join("\n"),
  ]),
);

function handleGithubPullRequestWebhook(itx: Project, event: StreamEvent) {
  return handleGithubPullRequestWebhookWithPolicy(itx, event, policy);
}

const route = {
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
  repositoryId: 101,
} satisfies GithubRepoLink;

const agentPath = "/agents/repos/config/pr/7";
const linterPath = `${agentPath}/ai-linter`;
const iterateAgentPath = "/agents/repos/iterate/pr/7";
const iterateLinterPath = `${iterateAgentPath}/ai-linter`;

function webhook(input?: {
  action?: string;
  appSlug?: string;
  authorAssociation?: string;
  authorType?: string;
  baseSha?: string;
  commentBody?: string | null;
  draft?: boolean;
  headSha?: string;
  installationId?: string;
  mentionedUsers?: string[];
  name?: string;
  offset?: number;
  owner?: string;
  path?: string;
  pullRequest?: boolean;
  repo?: string;
  repositoryId?: number;
  reviewBody?: string | null;
}): StreamEvent {
  const action = input?.action ?? "opened";
  const name = input?.name ?? "pull_request";
  const offset = input?.offset ?? 12;
  return {
    type: "events.iterate.com/github/webhook-received",
    createdAt: "2026-07-17T12:00:00.000Z",
    offset,
    path: input?.path ?? "/integrations/github/install-789",
    payload: {
      appSlug: input?.appSlug ?? "iterate",
      associations: {
        author: {
          association: input?.authorAssociation ?? "MEMBER",
          login: "jonas",
          type: input?.authorType ?? "User",
        },
        mentionedUsers: input?.mentionedUsers ?? [],
        ...(input?.pullRequest === false ? {} : { pullRequest: { number: 7 } }),
        repository: {
          id: input?.repositoryId ?? 101,
          owner: input?.owner ?? "acme",
          repo: input?.repo ?? "widgets",
        },
      },
      body: {
        action,
        comment: {
          body: !input?.commentBody ? "@iterate please review" : input.commentBody,
          html_url: "https://github.com/acme/widgets/pull/7#issuecomment-991",
          id: 991,
        },
        pull_request: {
          base: { sha: input?.baseSha ?? "base-abc" },
          draft: input?.draft ?? false,
          head: { sha: input?.headSha ?? "head-abc" },
          number: 7,
          state: "open",
        },
        review: {
          body: !input?.reviewBody ? "@iterate please review" : input.reviewBody,
          html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-992",
          id: 992,
        },
      },
      delivery: { id: `delivery-${offset}`, name },
      installationId: input?.installationId ?? "789",
    },
  };
}

function harness(input?: {
  agentExists?: boolean;
  ruleFiles?: Record<string, string>;
  route?: GithubRepoLink | null;
  routes?: Record<string, GithubRepoLink | null>;
}) {
  const births = new Map<string, StreamEvent>();
  if (input?.agentExists) {
    births.set(agentPath, {
      type: "events.iterate.com/agent/created",
      createdAt: "2026-07-17T11:00:00.000Z",
      idempotencyKey: `agent/created:prj_1:${agentPath}`,
      offset: 1,
      path: agentPath,
      payload: {},
    });
  }
  const appendBatches: Array<{ events: StreamEventInput[]; path: string }> = [];
  const agentAppendBatches: Array<{ events: StreamEventInput[]; path: string }> = [];
  const committedEvents = new Map<string, StreamEvent[]>();
  const nextOffsets = new Map<string, number>();
  for (const [path, birth] of births) {
    committedEvents.set(path, [birth]);
    nextOffsets.set(path, 2);
  }
  const commit = (path: string, events: StreamEventInput[]) => {
    const committed = committedEvents.get(path) ?? [];
    const results = events.map((event) => {
      const existing = committed.find(
        ({ idempotencyKey }) => !!event.idempotencyKey && idempotencyKey === event.idempotencyKey,
      );
      if (existing) return existing;
      const appended: StreamEvent = {
        ...event,
        createdAt: "2026-07-17T12:00:02.000Z",
        offset: nextOffsets.get(path) ?? 1,
        path,
      };
      nextOffsets.set(path, appended.offset + 1);
      committed.push(appended);
      return appended;
    });
    committedEvents.set(path, committed);
    return results;
  };
  const append = vi.fn(async (path: string, ...events: StreamEventInput[]) => {
    appendBatches.push({ events, path });
    return commit(path, events);
  });
  const agentAppend = vi.fn(async (path: string, ...events: StreamEventInput[]) => {
    agentAppendBatches.push({ events, path });
    return commit(path, events);
  });
  const create = vi.fn(async (path: string) => {
    const birth: StreamEvent = {
      type: "events.iterate.com/agent/created",
      createdAt: "2026-07-17T12:00:01.000Z",
      idempotencyKey: `agent/created:prj_1:${path}`,
      offset: 1,
      path,
      payload: {},
    };
    births.set(path, birth);
    committedEvents.set(path, [birth]);
    nextOffsets.set(path, 2);
  });
  const getEvents = vi.fn(async (path: string) => {
    const birth = births.get(path);
    return !birth ? [] : [birth];
  });
  const subscribeToEventsFrom = vi.fn(async (_path: string, _args: unknown) => ({
    inbound: {},
    outbound: {},
  }));
  const agentGet = vi.fn((path: string) => ({
    append: (...events: StreamEventInput[]) => agentAppend(path, ...events),
    create: () => create(path),
    stream: {
      append: (...events: StreamEventInput[]) => append(path, ...events),
      getEvents: () => getEvents(path),
      subscribeToEventsFrom: (args: unknown) => subscribeToEventsFrom(path, args),
    },
  }));
  const routes = input?.routes ?? {
    "/repos/config": !input?.route ? route : input.route,
  };
  const availableRuleFiles = input?.ruleFiles || ruleFiles;
  const repoList = vi.fn(async () => Object.keys(routes).map((path) => ({ path })));
  const repoGet = vi.fn((path: string) => ({
    listFiles: async () => ({ commitOid: "rules-abc", paths: Object.keys(availableRuleFiles) }),
    readFile: async ({ path: filePath }: { path: string }) => {
      const content = availableRuleFiles[filePath];
      return !content ? null : { commitOid: "rules-abc", content, path: filePath };
    },
    processor: {
      snapshot: async () => ({ offset: 1, state: { github: routes[path] ?? null } }),
    },
  }));
  const project = {
    agents: { get: agentGet },
    // Project is an RPC stub in userspace: property reads are thenables until
    // awaited, even though the generated ergonomic interface exposes string.
    projectId: Promise.resolve("prj_1"),
    repos: { get: repoGet, list: repoList },
  };
  // This fake implements the handler's RPC calls; the generated Project
  // interface is intentionally much larger, so a structural cast is unavoidable.
  const itx = project as unknown as Project;
  return {
    agentAppend,
    agentAppendBatches,
    agentGet,
    append,
    appendBatches,
    create,
    getEvents,
    itx,
    repoGet,
    repoList,
    subscribeToEventsFrom,
  };
}

function eventsFor(batches: Array<{ events: StreamEventInput[]; path: string }>, path: string) {
  return batches.filter((batch) => batch.path === path).flatMap((batch) => batch.events);
}

describe("userspace GitHub pull-request routing", () => {
  it("creates separate conversational and linter agents and queues one analysis", async () => {
    const event = webhook();
    const test = harness();

    await handleGithubPullRequestWebhook(test.itx, event);

    expect(test.repoGet).toHaveBeenCalledWith("/repos/config");
    expect(test.agentGet).toHaveBeenCalledWith(agentPath);
    expect(test.agentGet).toHaveBeenCalledWith(linterPath);
    expect(test.create).toHaveBeenCalledTimes(2);
    expect(test.create).toHaveBeenCalledWith(agentPath);
    expect(test.create).toHaveBeenCalledWith(linterPath);
    const parentAgentEvents = eventsFor(test.agentAppendBatches, agentPath);
    const parentStreamEvents = eventsFor(test.appendBatches, agentPath);
    const linterAgentEvents = eventsFor(test.agentAppendBatches, linterPath);
    const linterStreamEvents = eventsFor(test.appendBatches, linterPath);

    expect(parentAgentEvents).toMatchObject([
      {
        idempotencyKey: "github-pr/agent-policy:v5",
        payload: {
          key: "github/pull-request-policy",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
          role: "developer",
        },
      },
      {
        idempotencyKey: "github-pr/summary:acme/widgets",
        payload: {
          activity: "Helping with acme/widgets#7",
          description: "Conversational GitHub agent for pull request #7 in acme/widgets.",
          title: "PR #7",
        },
        type: "events.iterate.com/agent/summary-updated",
      },
    ]);
    expect(JSON.stringify(parentAgentEvents[0])).toContain(
      "The sibling /ai-linter stream is the sole author of linter Check Runs and non-blocking COMMENT reviews",
    );
    expect(JSON.stringify(parentAgentEvents[0])).toContain(
      "Never create, submit, or dismiss a pull-request review",
    );
    expect(parentStreamEvents).toEqual([
      {
        type: "events.iterate.com/agent/binding-set",
        idempotencyKey: "github-pr/binding:install-789:789:101:acme/widgets",
        payload: {
          type: "github_pull_request",
          connection: "install-789",
          installationId: "789",
          owner: "acme",
          repo: "widgets",
          number: 7,
        },
      },
    ]);
    expect(test.subscribeToEventsFrom).not.toHaveBeenCalled();
    expect(linterAgentEvents).toMatchObject([
      {
        idempotencyKey: "github-ai-linter/turn-budget:v1",
        payload: {
          config: {
            maxAutonomousTurns: 10,
          },
        },
        type: "events.iterate.com/agent/configured",
      },
      {
        idempotencyKey: "github-ai-linter/agent-policy:v3",
        payload: {
          key: "github-ai-linter/policy",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
          role: "developer",
        },
      },
      {
        idempotencyKey: "github-ai-linter/summary:acme/widgets",
        payload: {
          activity: "Linting acme/widgets#7",
          description: "Automated rule diagnostics for pull request #7 in acme/widgets.",
          title: "AI linter · PR #7",
        },
      },
      {
        idempotencyKey: "github-ai-linter/task:7",
        payload: {
          key: "github-ai-linter/analysis:7",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
          refs: [
            {
              eventType: "events.iterate.com/github-ai-linter/analysis-requested",
              offset: 7,
              streamPath: linterPath,
              type: "event",
            },
          ],
          role: "developer",
        },
      },
      {
        idempotencyKey: "github-ai-linter/trigger:7",
        payload: {
          actor: { name: "github-ai-linter", type: "integration" },
          llmRequestPolicy: { behaviour: "interrupt-current-request" },
          role: "user",
        },
      },
    ]);
    expect(linterStreamEvents).toMatchObject([
      {
        type: "events.iterate.com/agent/binding-set",
        idempotencyKey: "github-ai-linter/binding:install-789:789:101:acme/widgets",
      },
      {
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey:
          "github-ai-linter/subscription:install-789:101:7:policy:2:stream:/agents/repos/config/pr/7/ai-linter",
        payload: {
          name: "github-ai-linter",
          filter: {
            eventTypes: Object.values(githubAiLinterEventTypes),
          },
          receiver: {
            action: "wake-processor",
          },
        },
      },
      {
        type: "events.iterate.com/github-ai-linter/analysis-requested",
        idempotencyKey:
          "github-ai-linter/analysis:install-789:iterate:101:acme/widgets:7:2:3:rules-abc:base-abc:head-abc",
        payload: {
          appSlug: "iterate",
          baseSha: "base-abc",
          connection: "install-789",
          headSha: "head-abc",
          policyVersion: "2",
          promptVersion: "3",
          pullRequestNumber: 7,
          repository: { id: 101, owner: "acme", repo: "widgets" },
          rules,
          rulesCommit: "rules-abc",
        },
      },
    ]);
    expect(JSON.stringify(linterStreamEvents[1])).toContain('"className":"GithubAiLinterApp"');
    expect(JSON.stringify(linterStreamEvents[1])).toMatch(
      /"durableWorkerKey":"app-gh-linter-[0-9a-f]{32}"/,
    );
    expect(JSON.stringify(linterAgentEvents[1])).toContain(
      "The stream processor mechanically publishes a green Check Run for clean analyses",
    );

    const task = JSON.stringify(linterAgentEvents[3]);
    expect(task).toContain("complete changed-file list");
    expect(task).toContain("octokit.paginate");
    expect(task).toContain("GET /repos/{owner}/{repo}/pulls/{pull_number}/files");
    expect(task).toContain("Never pass an `octokit.rest` method to `paginate`");
    expect(task).toContain("diagnostic-reported");
    expect(task).toContain("diagnostic-suppressed");
    expect(task).toContain("analysis-settled");
    expect(task).toContain("diagnosticKey");
    expect(task).toContain('\\"kind\\": \\"suggestion\\"');
    expect(task).toContain("iterate-lint-disable");
    expect(task).toContain("iterate-lint-enable");
    expect(task).toContain("iterate-lint-disable-line");
    expect(task).toContain("iterate-lint-disable-next-line");
    expect(task).toContain("structure/no-small-single-use-helper");
    expect(task).toContain("no `!`-prefixed negative glob");
    expect(task).toContain("!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}");
    expect(task).toContain("!**/{__tests__,test,tests,spec,specs}/**");
    expect(task).toContain("Do not publish anything to GitHub yourself");
    expect(task).not.toContain("exactly one consolidated COMMENT review");
  });

  it("routes each linked GitHub repository through its project-controlled repo path", async () => {
    const test = harness({
      routes: {
        "/repos/config": { ...route, repo: "config", repositoryId: 202 },
        "/repos/iterate": route,
      },
    });

    await handleGithubPullRequestWebhook(test.itx, webhook());

    expect(test.repoList).toHaveBeenCalledOnce();
    expect(test.agentGet).toHaveBeenCalledWith(iterateAgentPath);
    expect(test.agentGet).toHaveBeenCalledWith(iterateLinterPath);
    expect(test.create).toHaveBeenCalledWith(iterateAgentPath);
    expect(test.create).toHaveBeenCalledWith(iterateLinterPath);
    expect(test.appendBatches[0]?.path).toBe(iterateAgentPath);
    expect(test.subscribeToEventsFrom).not.toHaveBeenCalled();
  });

  it("self-heals both agents from a later synchronize delivery", async () => {
    const test = harness();

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-next" }),
    );

    expect(test.create).toHaveBeenCalledTimes(2);
    expect(test.create).toHaveBeenCalledWith(agentPath);
    expect(test.create).toHaveBeenCalledWith(linterPath);
    expect(
      eventsFor(test.appendBatches, linterPath).find(
        ({ type }) => type === "events.iterate.com/github-ai-linter/analysis-requested",
      ),
    ).toMatchObject({ payload: { headSha: "head-next" } });
  });

  it("does not recreate either agent when an opened delivery is redelivered", async () => {
    const test = harness();
    const event = webhook();

    await handleGithubPullRequestWebhook(test.itx, event);
    await handleGithubPullRequestWebhook(test.itx, event);

    expect(test.create).toHaveBeenCalledTimes(2);
    expect(test.create).toHaveBeenCalledWith(agentPath);
    expect(test.create).toHaveBeenCalledWith(linterPath);
    const analyses = eventsFor(test.appendBatches, linterPath).filter(
      ({ type }) => type === "events.iterate.com/github-ai-linter/analysis-requested",
    );
    expect(analyses).toHaveLength(2);
    expect(analyses[0]?.idempotencyKey).toBe(analyses[1]?.idempotencyKey);
    const tasks = eventsFor(test.agentAppendBatches, linterPath).filter(({ idempotencyKey }) =>
      idempotencyKey?.startsWith("github-ai-linter/task:"),
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.idempotencyKey).toBe(tasks[1]?.idempotencyKey);
    const triggers = eventsFor(test.agentAppendBatches, linterPath).filter(({ idempotencyKey }) =>
      idempotencyKey?.startsWith("github-ai-linter/trigger:"),
    );
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.idempotencyKey).toBe(triggers[1]?.idempotencyKey);
  });

  it("reuses one agent, interrupts on a new head, and deduplicates an unchanged head", async () => {
    const test = harness({ agentExists: true });

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-one", offset: 20 }),
    );
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-two", offset: 21 }),
    );
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-two", offset: 22 }),
    );

    expect(test.create).toHaveBeenCalledOnce();
    expect(test.create).toHaveBeenCalledWith(linterPath);
    const analyses = eventsFor(test.appendBatches, linterPath).filter(
      ({ type }) => type === "events.iterate.com/github-ai-linter/analysis-requested",
    );
    expect(analyses.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "github-ai-linter/analysis:install-789:iterate:101:acme/widgets:7:2:3:rules-abc:base-abc:head-one",
      "github-ai-linter/analysis:install-789:iterate:101:acme/widgets:7:2:3:rules-abc:base-abc:head-two",
      "github-ai-linter/analysis:install-789:iterate:101:acme/widgets:7:2:3:rules-abc:base-abc:head-two",
    ]);
    const tasks = eventsFor(test.agentAppendBatches, linterPath).filter(({ idempotencyKey }) =>
      idempotencyKey?.startsWith("github-ai-linter/task:"),
    );
    expect(tasks).toHaveLength(3);
    expect(tasks[1]).toMatchObject({
      payload: { llmRequestPolicy: { behaviour: "dont-trigger-request" } },
    });
    expect(tasks[1]?.idempotencyKey).toBe(tasks[2]?.idempotencyKey);
    const triggers = eventsFor(test.agentAppendBatches, linterPath).filter(({ idempotencyKey }) =>
      idempotencyKey?.startsWith("github-ai-linter/trigger:"),
    );
    expect(triggers).toHaveLength(3);
    expect(triggers[0]?.idempotencyKey).not.toBe(triggers[1]?.idempotencyKey);
    expect(triggers[1]?.idempotencyKey).toBe(triggers[2]?.idempotencyKey);
  });

  it.each([
    ["wrong connection", webhook({ path: "/integrations/github/other" })],
    ["wrong installation", webhook({ installationId: "999" })],
    ["wrong repository", webhook({ repositoryId: 202 })],
    ["no PR association", webhook({ pullRequest: false })],
  ])("ignores a %s event", async (_case, event) => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(test.itx, event);
    expect(test.create).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
  });

  it("uses signed current coordinates while retaining stable repository identity", async () => {
    const test = harness();
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ owner: "renamed", repo: "widgets-next" }),
    );

    const parentAgentEvents = eventsFor(test.agentAppendBatches, agentPath);
    const parentStreamEvents = eventsFor(test.appendBatches, agentPath);
    const linterAgentEvents = eventsFor(test.agentAppendBatches, linterPath);
    const linterStreamEvents = eventsFor(test.appendBatches, linterPath);

    expect(parentAgentEvents[1]).toEqual({
      type: "events.iterate.com/agent/summary-updated",
      idempotencyKey: "github-pr/summary:renamed/widgets-next",
      payload: {
        title: "PR #7",
        activity: "Helping with renamed/widgets-next#7",
        description: "Conversational GitHub agent for pull request #7 in renamed/widgets-next.",
      },
    });
    expect(parentStreamEvents[0]).toEqual({
      type: "events.iterate.com/agent/binding-set",
      idempotencyKey: "github-pr/binding:install-789:789:101:renamed/widgets-next",
      payload: {
        type: "github_pull_request",
        connection: "install-789",
        installationId: "789",
        owner: "renamed",
        repo: "widgets-next",
        number: 7,
      },
    });
    expect(
      linterStreamEvents.find(
        ({ type }) => type === "events.iterate.com/github-ai-linter/analysis-requested",
      ),
    ).toMatchObject({
      idempotencyKey:
        "github-ai-linter/analysis:install-789:iterate:101:renamed/widgets-next:7:2:3:rules-abc:base-abc:head-abc",
      payload: { repository: { id: 101, owner: "renamed", repo: "widgets-next" } },
    });
    expect(JSON.stringify(linterAgentEvents)).toContain(
      "Analyse renamed/widgets-next pull request #7",
    );
  });

  it("routes a signed trusted mention into one immediately actionable request", async () => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "created", mentionedUsers: ["iterate"], name: "issue_comment" }),
    );

    expect(test.appendBatches[0]?.events).toHaveLength(3);
    expect(test.appendBatches[0]?.events[1]).toMatchObject({
      idempotencyKey: "github-pr/mention-instructions:/integrations/github/install-789:12",
      payload: {
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
        role: "developer",
      },
    });
    expect(test.appendBatches[0]?.events[1]?.payload).not.toHaveProperty("actor");
    expect(test.appendBatches[0]?.events[2]).toMatchObject({
      idempotencyKey: "github-pr/mention:/integrations/github/install-789:12",
      payload: {
        actor: { login: "jonas", senderType: "User", type: "github" },
        llmRequestPolicy: { behaviour: "after-current-request" },
        refs: [
          {
            eventType: "events.iterate.com/github/webhook-received",
            offset: 12,
            streamPath: "/integrations/github/install-789",
            type: "event",
          },
        ],
      },
    });
    const instructions = JSON.stringify(test.appendBatches[0]?.events[1]);
    expect(instructions).toContain("GitHub's signed webhook identifies @jonas as MEMBER");
    expect(instructions).toContain("issues.createComment");
    expect(instructions).toContain("never create, submit, or dismiss a pull-request review");
    expect(instructions).not.toContain("@iterate please review");
    const request = JSON.stringify(test.appendBatches[0]?.events[2]);
    expect(request).toContain("@iterate please review");
    expect(request).toContain("https://github.com/acme/widgets/pull/7#issuecomment-991");
    expect(JSON.stringify(test.appendBatches[0]?.events)).not.toContain("checkCollaborator");

    const ignored = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      ignored.itx,
      webhook({
        action: "created",
        authorAssociation: "CONTRIBUTOR",
        mentionedUsers: ["iterate"],
        name: "issue_comment",
      }),
    );
    expect(ignored.repoList).not.toHaveBeenCalled();
    expect(ignored.appendBatches).toHaveLength(0);
  });

  it("takes submitted review text from the committed webhook without rereading its ref", async () => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({
        action: "submitted",
        commentBody: "wrong field",
        mentionedUsers: ["iterate"],
        name: "pull_request_review",
        reviewBody: "@iterate answer this review",
      }),
    );

    expect(JSON.stringify(test.appendBatches[0]?.events[2])).toContain(
      "@iterate answer this review",
    );
    expect(JSON.stringify(test.appendBatches[0]?.events[2])).not.toContain("wrong field");
  });

  it("does not wake from normalized mention metadata when the native message body is absent", async () => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({
        action: "created",
        commentBody: null,
        mentionedUsers: ["iterate"],
        name: "issue_comment",
      }),
    );

    expect(test.repoList).not.toHaveBeenCalled();
    expect(test.appendBatches).toHaveLength(0);
  });

  it("creates the pull-request agent from a trusted mention", async () => {
    const test = harness();
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "created", mentionedUsers: ["iterate"], name: "issue_comment" }),
    );

    expect(test.create).toHaveBeenCalledOnce();
    expect(test.appendBatches[0]?.events).toHaveLength(3);
    expect(test.appendBatches[0]?.events[2]).toMatchObject({
      payload: {
        actor: { login: "jonas", senderType: "User", type: "github" },
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
      type: "events.iterate.com/agents/context-added",
    });
  });

  it("routes a trusted mention without loading structural review rules", async () => {
    const test = harness();
    const loadRules = vi.fn(async () => {
      throw new Error("rules are unavailable");
    });

    await handleGithubPullRequestWebhookWithPolicy(
      test.itx,
      webhook({ action: "created", mentionedUsers: ["iterate"], name: "issue_comment" }),
      { config, loadRules },
    );

    expect(loadRules).not.toHaveBeenCalled();
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.appendBatches[0]?.events).toHaveLength(3);
  });

  it("creates draft history without waking a review", async () => {
    const test = harness();
    await handleGithubPullRequestWebhook(test.itx, webhook({ draft: true }));
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.appendBatches[0]?.events).toHaveLength(1);
  });

  it("leaves native thread resolution to the durable agent subscription", async () => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "resolved", name: "pull_request_review_thread" }),
    );
    expect(test.repoList).not.toHaveBeenCalled();
    expect(test.appendBatches).toHaveLength(0);
  });
});
