import { describe, expect, it, vi } from "vitest";
import type { GithubRepoLink, Project, StreamEvent, StreamEventInput } from "iterate/sdk";
import { handleGithubPullRequestWebhook } from "../../../config-repo-template/worker.ts";

const route = {
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
  repositoryId: 101,
} satisfies GithubRepoLink;

const agentPath = "/agents/repos/config/pr/7";
const iterateAgentPath = "/agents/repos/iterate/pr/7";

function webhook(input?: {
  action?: string;
  appSlug?: string;
  authorAssociation?: string;
  authorType?: string;
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
          body: input?.commentBody === undefined ? "@iterate please review" : input.commentBody,
          html_url: "https://github.com/acme/widgets/pull/7#issuecomment-991",
          id: 991,
        },
        pull_request: {
          draft: input?.draft ?? false,
          head: { sha: input?.headSha ?? "head-abc" },
          number: 7,
          state: "open",
        },
        review: {
          body: input?.reviewBody === undefined ? "@iterate please review" : input.reviewBody,
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
  const append = vi.fn(async (path: string, ...events: StreamEventInput[]) => {
    appendBatches.push({ events, path });
    return [];
  });
  const agentAppend = vi.fn(async (path: string, ...events: StreamEventInput[]) => {
    agentAppendBatches.push({ events, path });
    return [];
  });
  const create = vi.fn(async (path: string) => {
    births.set(path, {
      type: "events.iterate.com/agent/created",
      createdAt: "2026-07-17T12:00:01.000Z",
      idempotencyKey: `agent/created:prj_1:${path}`,
      offset: 1,
      path,
      payload: {},
    });
  });
  const getEvents = vi.fn(async (path: string) => {
    const birth = births.get(path);
    return birth === undefined ? [] : [birth];
  });
  const agentGet = vi.fn((path: string) => ({
    append: (...events: StreamEventInput[]) => agentAppend(path, ...events),
    create: () => create(path),
    stream: {
      append: (...events: StreamEventInput[]) => append(path, ...events),
      getEvents: () => getEvents(path),
    },
  }));
  const routes = input?.routes ?? {
    "/repos/config": input?.route === undefined ? route : input.route,
  };
  const repoList = vi.fn(async () => Object.keys(routes).map((path) => ({ path })));
  const repoGet = vi.fn((path: string) => ({
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
  };
}

describe("userspace GitHub pull-request routing", () => {
  it("creates the repo-addressed agent and queues one structural review", async () => {
    const event = webhook();
    const test = harness();

    await handleGithubPullRequestWebhook(test.itx, event);

    expect(test.repoGet).toHaveBeenCalledWith("/repos/config");
    expect(test.agentGet).toHaveBeenCalledWith(agentPath);
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.create).toHaveBeenCalledWith(agentPath);
    expect(test.agentAppendBatches).toHaveLength(1);
    expect(test.agentAppendBatches[0]).toMatchObject({
      path: agentPath,
      events: [
        {
          idempotencyKey: "github-pr/agent-policy:v2",
          payload: {
            key: "github/pull-request-policy",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
            role: "developer",
          },
        },
        {
          idempotencyKey: "github-pr/metadata",
          payload: {
            activity: "Reviewing acme/widgets#7",
            summary: "Reviewing pull request #7 in acme/widgets and reporting findings on GitHub.",
            title: "PR #7",
          },
          type: "events.iterate.com/agent/metadata-changed",
        },
      ],
    });
    expect(JSON.stringify(test.agentAppendBatches[0]?.events[0])).toContain(
      "Do not change code, refs, labels, or merge state",
    );
    expect(test.appendBatches).toHaveLength(1);
    expect(test.appendBatches[0]?.path).toBe(agentPath);
    expect(test.appendBatches[0]?.events).toHaveLength(3);
    expect(test.appendBatches[0]?.events[0]).toEqual({
      type: "events.iterate.com/agent/binding-set",
      idempotencyKey: "github-pr/binding",
      payload: {
        type: "github_pull_request",
        connection: "install-789",
        installationId: "789",
        owner: "acme",
        repo: "widgets",
        number: 7,
      },
    });
    expect(test.appendBatches[0]?.events[1]).toMatchObject({
      idempotencyKey: "github-pr/webhook:/integrations/github/install-789:12",
      payload: event.payload,
      source: {
        crossPostedFrom: [
          expect.objectContaining({
            offset: 12,
            path: "/integrations/github/install-789",
            projectId: "prj_1",
            subscriptionKey: "userspace:github-pr:/repos/config",
          }),
        ],
      },
    });
    expect(test.appendBatches[0]?.events[2]).toMatchObject({
      idempotencyKey: "github-pr/review:install-789:101:acme/widgets:iterate:2:head-abc",
      payload: {
        key: "github/review-task",
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
        role: "developer",
      },
      type: "events.iterate.com/agents/context-added",
    });
    const task = JSON.stringify(test.appendBatches[0]?.events[2]);
    expect(task).toContain("complete changed-file list");
    expect(task).toContain("octokit.paginate");
    expect(task).toContain("GET /repos/{owner}/{repo}/pulls/{pull_number}/files");
    expect(task).toContain("Never pass an `octokit.rest` method to `octokit.paginate`");
    expect(task).toContain("Return plain JSON data from the script");
    expect(task).toContain("exactly one consolidated COMMENT review");
    expect(task).toContain("iterate-lint-disable-next-line");
    expect(task).toContain("structure/no-small-single-use-helper");
    expect(task).toContain("no `!`-prefixed negative glob");
    expect(task).toContain("!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}");
    expect(task).toContain("!**/{__tests__,test,tests,spec,specs}/**");
    expect(task).toContain("<!-- iterate-ai-lint:101:policy:2:head:head-abc -->");
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
    expect(test.create).toHaveBeenCalledWith(iterateAgentPath);
    expect(test.appendBatches[0]?.path).toBe(iterateAgentPath);
    expect(test.appendBatches[0]?.events[1]).toMatchObject({
      source: {
        crossPostedFrom: [{ subscriptionKey: "userspace:github-pr:/repos/iterate" }],
      },
    });
  });

  it("does not create from an unmentioned later delivery", async () => {
    const test = harness();

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-next" }),
    );

    expect(test.create).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
  });

  it("does not recreate the agent when an opened delivery is redelivered", async () => {
    const test = harness();
    const event = webhook();

    await handleGithubPullRequestWebhook(test.itx, event);
    await handleGithubPullRequestWebhook(test.itx, event);

    expect(test.create).toHaveBeenCalledOnce();
    expect(test.appendBatches).toHaveLength(2);
    expect(test.appendBatches[1]?.events.map((item) => item.idempotencyKey)).toEqual([
      "github-pr/binding",
      "github-pr/webhook:/integrations/github/install-789:12",
      "github-pr/review:install-789:101:acme/widgets:iterate:2:head-abc",
    ]);
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

    expect(test.create).not.toHaveBeenCalled();
    const reviews = test.appendBatches.map((batch) => batch.events[2]);
    expect(reviews.map((review) => review?.idempotencyKey)).toEqual([
      "github-pr/review:install-789:101:acme/widgets:iterate:2:head-one",
      "github-pr/review:install-789:101:acme/widgets:iterate:2:head-two",
      "github-pr/review:install-789:101:acme/widgets:iterate:2:head-two",
    ]);
    expect(reviews[1]).toMatchObject({
      payload: { llmRequestPolicy: { behaviour: "interrupt-current-request" } },
    });
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

    expect(test.agentAppendBatches[0]?.events[1]).toEqual({
      type: "events.iterate.com/agent/metadata-changed",
      idempotencyKey: "github-pr/metadata",
      payload: {
        title: "PR #7",
        activity: "Reviewing renamed/widgets-next#7",
        summary:
          "Reviewing pull request #7 in renamed/widgets-next and reporting findings on GitHub.",
      },
    });
    expect(test.appendBatches[0]?.events[0]).toEqual({
      type: "events.iterate.com/agent/binding-set",
      idempotencyKey: "github-pr/binding",
      payload: {
        type: "github_pull_request",
        connection: "install-789",
        installationId: "789",
        owner: "renamed",
        repo: "widgets-next",
        number: 7,
      },
    });
    expect(JSON.stringify(test.appendBatches[0]?.events[2])).toContain(
      "renamed/widgets-next pull request #7",
    );
    expect(test.appendBatches[0]?.events[2]?.idempotencyKey).toBe(
      "github-pr/review:install-789:101:renamed/widgets-next:iterate:2:head-abc",
    );
  });

  it("routes a signed trusted mention into one immediately actionable request", async () => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "created", mentionedUsers: ["iterate"], name: "issue_comment" }),
    );

    expect(test.appendBatches[0]?.events).toHaveLength(4);
    expect(test.appendBatches[0]?.events[2]).toMatchObject({
      idempotencyKey: "github-pr/mention-instructions:/integrations/github/install-789:12",
      payload: {
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
        role: "developer",
      },
    });
    expect(test.appendBatches[0]?.events[2]?.payload).not.toHaveProperty("actor");
    expect(test.appendBatches[0]?.events[3]).toMatchObject({
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
    const instructions = JSON.stringify(test.appendBatches[0]?.events[2]);
    expect(instructions).toContain("GitHub's signed webhook identifies @jonas as MEMBER");
    expect(instructions).toContain("issues.createComment");
    expect(instructions).not.toContain("@iterate please review");
    const request = JSON.stringify(test.appendBatches[0]?.events[3]);
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
    expect(ignored.appendBatches[0]?.events).toHaveLength(2);
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

    expect(JSON.stringify(test.appendBatches[0]?.events[3])).toContain(
      "@iterate answer this review",
    );
    expect(JSON.stringify(test.appendBatches[0]?.events[3])).not.toContain("wrong field");
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

    expect(test.appendBatches[0]?.events).toHaveLength(2);
  });

  it("creates the pull-request agent from a trusted mention", async () => {
    const test = harness();
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "created", mentionedUsers: ["iterate"], name: "issue_comment" }),
    );

    expect(test.create).toHaveBeenCalledOnce();
    expect(test.appendBatches[0]?.events).toHaveLength(4);
    expect(test.appendBatches[0]?.events[3]).toMatchObject({
      payload: {
        actor: { login: "jonas", senderType: "User", type: "github" },
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
      type: "events.iterate.com/agents/context-added",
    });
  });

  it("creates draft history without waking a review", async () => {
    const test = harness();
    await handleGithubPullRequestWebhook(test.itx, webhook({ draft: true }));
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.appendBatches[0]?.events).toHaveLength(2);
  });

  it("copies native thread resolution without waking the agent", async () => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "resolved", name: "pull_request_review_thread" }),
    );
    expect(test.appendBatches[0]?.events).toHaveLength(2);
    expect(test.appendBatches[0]?.events[1]).toMatchObject({
      payload: { body: { action: "resolved" }, delivery: { name: "pull_request_review_thread" } },
      type: "events.iterate.com/github/webhook-received",
    });
  });
});
