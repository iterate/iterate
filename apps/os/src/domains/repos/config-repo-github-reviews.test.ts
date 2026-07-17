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

function webhook(input?: {
  action?: string;
  appSlug?: string;
  authorAssociation?: string;
  authorType?: string;
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
        comment: { body: "@iterate please review", id: 991 },
        pull_request: {
          draft: input?.draft ?? false,
          head: { sha: input?.headSha ?? "head-abc" },
          number: 7,
          state: "open",
        },
      },
      delivery: { id: `delivery-${offset}`, name },
      installationId: input?.installationId ?? "789",
    },
  };
}

function harness(input?: { agentExists?: boolean; route?: GithubRepoLink | null }) {
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
  const snapshot = vi.fn(async () => ({
    offset: 1,
    state: { github: input?.route === undefined ? route : input.route },
  }));
  const repoGet = vi.fn(() => ({ processor: { snapshot } }));
  const project = {
    agents: { get: agentGet },
    projectId: "prj_1",
    repos: { get: repoGet },
  };
  // This fake implements the handler's three RPC calls; the generated Project
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
          idempotencyKey: "github-pr/agent-policy:v1",
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
      "Do not change repository state",
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
      idempotencyKey: "github-pr/review:install-789:101:acme/widgets:iterate:1:head-abc",
      payload: {
        key: "github/review-task",
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
        role: "developer",
      },
      type: "events.iterate.com/agents/context-added",
    });
    const task = JSON.stringify(test.appendBatches[0]?.events[2]);
    expect(task).toContain("complete changed-file list");
    expect(task).toContain("exactly one consolidated COMMENT review");
    expect(task).toContain("iterate-lint-disable-next-line");
    expect(task).toContain("structure/no-small-single-use-helper");
    expect(task).toContain("<!-- iterate-ai-lint:101:policy:1:head:head-abc -->");
  });

  it("creates only from pull_request:opened", async () => {
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
      "github-pr/review:install-789:101:acme/widgets:iterate:1:head-abc",
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
      "github-pr/review:install-789:101:acme/widgets:iterate:1:head-one",
      "github-pr/review:install-789:101:acme/widgets:iterate:1:head-two",
      "github-pr/review:install-789:101:acme/widgets:iterate:1:head-two",
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
      "github-pr/review:install-789:101:renamed/widgets-next:iterate:1:head-abc",
    );
  });

  it("routes a trusted mention and asks GitHub for the authoritative access check", async () => {
    const test = harness({ agentExists: true });
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "created", mentionedUsers: ["iterate"], name: "issue_comment" }),
    );

    expect(test.appendBatches[0]?.events).toHaveLength(3);
    expect(test.appendBatches[0]?.events[2]).toMatchObject({
      payload: {
        actor: { login: "jonas", senderType: "User", type: "github" },
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    expect(JSON.stringify(test.appendBatches[0]?.events[2])).toContain("checkCollaborator");

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
