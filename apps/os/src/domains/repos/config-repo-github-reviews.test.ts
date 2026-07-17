import { describe, expect, it, vi } from "vitest";
import type { GithubRepoLink, Project, StreamEvent, StreamEventInput } from "iterate/sdk";
import { handleGithubPullRequestWebhook } from "../../../config-repo-template/worker.ts";

const ROUTE: GithubRepoLink = {
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
  repositoryId: 101,
};

const AGENT_PATH = "/agents/repos/config/pr/7";

function webhook(input?: {
  action?: string;
  actorAssociation?: string;
  actorId?: number;
  actorLogin?: string;
  actorType?: string;
  appSlug?: string | null;
  crossPosted?: boolean;
  draft?: boolean;
  headSha?: string;
  installationId?: string;
  mentionedUsers?: string[];
  name?: string;
  offset?: number;
  path?: string;
  pullRequests?: Array<{ basis: "head" | "subject"; number: number; repositoryId: number }>;
  repositoryFullName?: string;
  repositoryId?: number;
}): StreamEvent {
  const name = input?.name ?? "pull_request";
  const action = input?.action ?? "opened";
  const number = 7;
  const actorId = input?.actorId ?? 44;
  const actorLogin = input?.actorLogin ?? "jonas";
  return {
    type: "events.iterate.com/github/webhook-received",
    createdAt: "2026-07-17T12:00:00.000Z",
    offset: input?.offset ?? 12,
    path: input?.path ?? "/integrations/github/install-789",
    ...(input?.crossPosted
      ? {
          source: {
            crossPostedFrom: [
              {
                subscriptionKey: "github-repo:/repos/config",
                createdAt: "2026-07-17T11:59:59.000Z",
                offset: 10,
                path: "/integrations/github/install-789",
                projectId: "prj_1",
                type: "events.iterate.com/github/webhook-received",
              },
            ],
          },
        }
      : {}),
    payload: {
      ...(input?.appSlug === null ? {} : { appSlug: input?.appSlug ?? "iterate" }),
      associations: {
        actor: { id: actorId, login: actorLogin, type: input?.actorType ?? "User" },
        contentAuthor: {
          authorAssociation: input?.actorAssociation ?? "MEMBER",
          id: 44,
          login: "jonas",
          type: input?.actorType ?? "User",
        },
        mentionedUsers: input?.mentionedUsers ?? [],
        problems: [],
        pullRequests: input?.pullRequests ?? [
          {
            basis: name === "check_run" ? "head" : "subject",
            number,
            repositoryId: input?.repositoryId ?? 101,
          },
        ],
        repository: { fullName: input?.repositoryFullName ?? "acme/widgets", id: 101 },
      },
      body: {
        action,
        comment: { body: "@iterate please review", id: 991 },
        pull_request: {
          draft: input?.draft ?? false,
          head: { sha: input?.headSha ?? "head-abc" },
          number,
          state: "open",
        },
      },
      delivery: { action, id: `delivery-${input?.offset ?? 12}`, name },
      installationId: input?.installationId ?? "789",
    },
  };
}

function association(payload?: Record<string, unknown>): StreamEvent {
  return {
    type: "events.iterate.com/github/pull-request-associated",
    createdAt: "2026-07-17T11:00:00.000Z",
    idempotencyKey: "github-pr/association",
    offset: 1,
    path: AGENT_PATH,
    payload: payload ?? { number: 7, repoPath: "/repos/config", repositoryId: 101 },
  };
}

function harness(input?: {
  association?: StreamEvent;
  birth?: StreamEvent;
  route?: GithubRepoLink | null;
}) {
  const associations = new Map<string, StreamEvent>();
  if (input?.association !== undefined) associations.set(AGENT_PATH, input.association);
  const births = new Map<string, StreamEvent>();
  if (input?.birth !== undefined) births.set(AGENT_PATH, input.birth);

  const create = vi.fn(
    async (path: string, request: { initialEvents: StreamEventInput[]; systemPrompt: string }) => {
      const initial = request.initialEvents[0];
      if (initial === undefined) throw new Error("Agent creation omitted its association event");
      associations.set(path, {
        ...initial,
        createdAt: "2026-07-17T12:00:01.000Z",
        offset: 1,
        path,
      });
    },
  );
  const appendBatches: Array<{ events: StreamEventInput[]; path: string }> = [];
  const append = vi.fn(async (path: string, ...events: StreamEventInput[]) => {
    appendBatches.push({ events, path });
    return [];
  });
  const getEvent = vi.fn(async (path: string, request: { idempotencyKey: string }) =>
    request.idempotencyKey === "github-pr/association" ? associations.get(path) : births.get(path),
  );
  const agentGet = vi.fn((path: string) => ({
    create: (request: { initialEvents: StreamEventInput[]; systemPrompt: string }) =>
      create(path, request),
    stream: {
      append: (...events: StreamEventInput[]) => append(path, ...events),
      getEvent: (request: { idempotencyKey: string }) => getEvent(path, request),
    },
  }));

  const snapshot = vi.fn(async () => ({
    offset: 1,
    state: { github: input?.route === undefined ? ROUTE : input.route },
  }));
  const repoGet = vi.fn(() => ({ processor: { snapshot } }));
  const rejected: StreamEventInput[] = [];
  const rejectionAppend = vi.fn(async (...events: StreamEventInput[]) => {
    rejected.push(...events);
    return [];
  });
  const streamGet = vi.fn(() => ({ append: rejectionAppend }));

  const partialProject = {
    agents: { get: agentGet },
    projectId: "prj_1",
    repos: { get: repoGet },
    streams: { get: streamGet },
  };
  // This focused fake implements exactly the handler's RPC surface; the full
  // generated Project interface is intentionally much larger.
  const itx = partialProject as unknown as Project;
  return {
    agentGet,
    append,
    appendBatches,
    create,
    getEvent,
    itx,
    rejected,
    rejectionAppend,
    repoGet,
    snapshot,
    streamGet,
  };
}

describe("userspace GitHub pull-request routing", () => {
  it("creates one repo-addressed agent and appends the original webhook plus review task", async () => {
    const event = webhook();
    const test = harness();

    await handleGithubPullRequestWebhook(test.itx, event);

    expect(test.repoGet).toHaveBeenCalledWith("/repos/config");
    expect(test.agentGet).toHaveBeenCalledWith(AGENT_PATH);
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.create).toHaveBeenCalledWith(
      AGENT_PATH,
      expect.objectContaining({
        initialEvents: expect.arrayContaining([
          expect.objectContaining({
            idempotencyKey: "github-pr/association",
            payload: { number: 7, repoPath: "/repos/config", repositoryId: 101 },
          }),
          expect.objectContaining({
            idempotencyKey: "github-pr/status",
            payload: { icon: "github", note: "acme/widgets#7", title: "PR #7" },
          }),
        ]),
      }),
    );
    expect(test.create.mock.calls[0]?.[1].systemPrompt).toContain(
      "Do not change files, commits, branches, labels, assignees, merge state",
    );

    expect(test.appendBatches).toHaveLength(1);
    const batch = test.appendBatches[0];
    expect(batch?.path).toBe(AGENT_PATH);
    expect(batch?.events).toHaveLength(2);
    expect(batch?.events[0]).toMatchObject({
      idempotencyKey: "github-pr/webhook:/integrations/github/install-789:12",
      payload: event.payload,
      source: {
        crossPostedFrom: [
          expect.objectContaining({
            offset: 12,
            path: "/integrations/github/install-789",
            projectId: "prj_1",
            subscriptionKey: "userspace:github-pr:/repos/config:7",
          }),
        ],
      },
      type: event.type,
    });
    expect(batch?.events[1]).toMatchObject({
      idempotencyKey:
        "github-pr/review:install-789:789:101:acme/widgets:1:head-abc:/integrations/github/install-789:12",
      payload: {
        key: "github/review-task",
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
        role: "developer",
      },
      type: "events.iterate.com/agents/context-added",
    });
    const renderedTask = JSON.stringify(batch?.events[1]);
    expect(renderedTask).toContain("exactly one consolidated COMMENT review");
    expect(renderedTask).toContain("iterate-lint-disable-next-line");
    expect(renderedTask).toContain('at ref \\"head-abc\\"');
    expect(renderedTask).toContain("pulls/{pull_number}/reviews");
    expect(renderedTask).toContain("application/vnd.github.v3.diff");
    expect(renderedTask).toContain("not cover every applicable added line");
    expect(renderedTask).toContain("reviewThreads(first: 100, after: $cursor)");
    expect(renderedTask).toContain("isResolved");
    expect(renderedTask).toContain("structure/no-small-single-use-helper");
    expect(renderedTask).toContain("<!-- iterate-ai-lint:101:policy:1:head:head-abc -->");
  });

  it("does not create an agent for a later event whose opened event was never routed", async () => {
    const test = harness();

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-next" }),
    );

    expect(test.create).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
  });

  it("rejects an opened PR when its userspace agent path is already occupied", async () => {
    const test = harness({
      birth: {
        type: "events.iterate.com/agent/created",
        createdAt: "2026-07-17T11:00:00.000Z",
        idempotencyKey: `agent/created:prj_1:${AGENT_PATH}`,
        offset: 1,
        path: AGENT_PATH,
        payload: { config: { systemPrompt: "unrelated agent" } },
      },
    });

    await handleGithubPullRequestWebhook(test.itx, webhook());

    expect(test.create).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
    expect(test.rejected).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "agent-path-already-occupied" }),
        type: "events.iterate.com/github/pull-request-routing-rejected",
      }),
    ]);
  });

  it("reuses one agent and interrupts an older review task when the head changes", async () => {
    const test = harness({ association: association() });

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-one", offset: 20 }),
    );
    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "synchronize", headSha: "head-two", offset: 21 }),
    );

    expect(test.create).not.toHaveBeenCalled();
    expect(test.appendBatches).toHaveLength(2);
    const firstReview = test.appendBatches[0]?.events[1];
    const secondReview = test.appendBatches[1]?.events[1];
    expect(firstReview).toMatchObject({
      idempotencyKey: expect.stringContaining(":head-one"),
      payload: {
        key: "github/review-task",
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
      },
    });
    expect(secondReview).toMatchObject({
      idempotencyKey: expect.stringContaining(":head-two"),
      payload: {
        key: "github/review-task",
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
      },
    });
  });

  it("uses current webhook coordinates while retaining the stable repository identity", async () => {
    const test = harness();

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ repositoryFullName: "renamed/widgets-next" }),
    );

    expect(test.create.mock.calls[0]?.[1].initialEvents).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ note: "renamed/widgets-next#7" }),
      }),
    );
    expect(JSON.stringify(test.appendBatches[0]?.events[1])).toContain(
      "renamed/widgets-next pull request #7",
    );
    expect(test.appendBatches[0]?.events[1]?.idempotencyKey).toContain(
      ":101:renamed/widgets-next:1:head-abc:",
    );
  });

  it("gives separate source deliveries for the same head separate append identities", async () => {
    const test = harness({ association: association() });

    await handleGithubPullRequestWebhook(test.itx, webhook({ headSha: "head-one", offset: 20 }));
    await handleGithubPullRequestWebhook(test.itx, webhook({ headSha: "head-one", offset: 22 }));

    const firstReview = test.appendBatches[0]?.events[1];
    const secondReview = test.appendBatches[1]?.events[1];
    expect(firstReview?.idempotencyKey).toContain(":head-one:/integrations/github/install-789:20");
    expect(secondReview?.idempotencyKey).toContain(":head-one:/integrations/github/install-789:22");
    expect(JSON.stringify(firstReview)).toContain(
      "<!-- iterate-ai-lint:101:policy:1:head:head-one -->",
    );
    expect(JSON.stringify(secondReview)).toContain(
      "<!-- iterate-ai-lint:101:policy:1:head:head-one -->",
    );
  });

  it.each([
    { label: "cross-posted", event: webhook({ crossPosted: true }) },
    { label: "wrong connection", event: webhook({ path: "/integrations/github/other" }) },
    { label: "wrong installation", event: webhook({ installationId: "999" }) },
    { label: "wrong repository", event: webhook({ repositoryId: 202 }) },
    { label: "no PR association", event: webhook({ pullRequests: [] }) },
  ])("ignores a $label event", async ({ event }) => {
    const test = harness({ association: association() });

    await handleGithubPullRequestWebhook(test.itx, event);

    expect(test.create).not.toHaveBeenCalled();
    expect(test.append).not.toHaveBeenCalled();
    expect(test.rejectionAppend).not.toHaveBeenCalled();
  });

  it("records an observable rejection instead of routing through a mismatched agent", async () => {
    const test = harness({
      association: association({ number: 8, repoPath: "/repos/config", repositoryId: 101 }),
    });

    await handleGithubPullRequestWebhook(test.itx, webhook());

    expect(test.append).not.toHaveBeenCalled();
    expect(test.streamGet).toHaveBeenCalledWith("/integrations/github/install-789");
    expect(test.rejected).toEqual([
      expect.objectContaining({
        idempotencyKey: "github-pr/routing-rejected:12:/agents/repos/config/pr/7",
        payload: expect.objectContaining({ reason: "agent-association-mismatch" }),
        type: "events.iterate.com/github/pull-request-routing-rejected",
      }),
    ]);
  });

  it("wakes only for a trusted mention whose webhook sender authored the content", async () => {
    const test = harness({ association: association() });

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "created", mentionedUsers: ["Iterate"], name: "issue_comment" }),
    );

    expect(test.appendBatches[0]?.events).toHaveLength(2);
    expect(test.appendBatches[0]?.events[1]).toMatchObject({
      payload: {
        actor: { login: "jonas", senderType: "User", type: "github" },
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
    expect(JSON.stringify(test.appendBatches[0]?.events[1])).toContain("checkCollaborator");

    for (const untrusted of [
      webhook({
        action: "created",
        actorId: 99,
        actorLogin: "moderator",
        mentionedUsers: ["iterate"],
        name: "issue_comment",
      }),
      webhook({
        action: "created",
        actorAssociation: "CONTRIBUTOR",
        mentionedUsers: ["iterate"],
        name: "issue_comment",
      }),
      webhook({
        action: "created",
        actorType: "Bot",
        mentionedUsers: ["iterate"],
        name: "issue_comment",
      }),
    ]) {
      const ignored = harness({ association: association() });
      await handleGithubPullRequestWebhook(ignored.itx, untrusted);
      expect(ignored.appendBatches[0]?.events).toHaveLength(1);
    }
  });

  it("addresses mentions to the GitHub App that received this delivery", async () => {
    const ignored = harness({ association: association() });
    await handleGithubPullRequestWebhook(
      ignored.itx,
      webhook({
        action: "created",
        appSlug: "iterate-preview-3",
        mentionedUsers: ["iterate"],
        name: "issue_comment",
      }),
    );
    expect(ignored.appendBatches[0]?.events).toHaveLength(1);

    const addressed = harness({ association: association() });
    await handleGithubPullRequestWebhook(
      addressed.itx,
      webhook({
        action: "created",
        appSlug: "iterate-preview-3",
        mentionedUsers: ["iterate-preview-3"],
        name: "issue_comment",
      }),
    );
    expect(addressed.appendBatches[0]?.events[1]).toMatchObject({
      payload: { actor: { login: "jonas", type: "github" } },
      type: "events.iterate.com/agents/context-added",
    });
  });

  it("creates draft PR history without waking a review", async () => {
    const test = harness();

    await handleGithubPullRequestWebhook(test.itx, webhook({ draft: true }));

    expect(test.create).toHaveBeenCalledOnce();
    expect(test.appendBatches[0]?.events).toHaveLength(1);
    expect(test.appendBatches[0]?.events[0]?.type).toBe(
      "events.iterate.com/github/webhook-received",
    );
  });

  it("copies native thread resolution into the existing PR history without waking it", async () => {
    const test = harness({ association: association() });

    await handleGithubPullRequestWebhook(
      test.itx,
      webhook({ action: "resolved", name: "pull_request_review_thread" }),
    );

    expect(test.appendBatches).toHaveLength(1);
    expect(test.appendBatches[0]?.events).toHaveLength(1);
    expect(test.appendBatches[0]?.events[0]).toMatchObject({
      payload: { delivery: { action: "resolved", name: "pull_request_review_thread" } },
      type: "events.iterate.com/github/webhook-received",
    });
  });
});
