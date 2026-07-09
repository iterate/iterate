// Unit tests for linkRepoToGithub / unlinkRepoFromGithub — the itx-side flow
// behind repo.linkGithub(). There is NO network: the connection stream, the
// connection secret's fetch (which is how the wrapped Octokit reaches
// "GitHub"), and the Repo Durable Object are all in-memory fakes on the same
// itxEnv seam the connect-flow tests use. The GitHub-touching push/sync
// mechanics live on the Repo DO and are proven against real GitHub in
// production smoke, not here.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { GITHUB_CONNECTED_EVENT_TYPE } from "../integrations/utils.ts";
import { linkRepoToGithub, unlinkRepoFromGithub } from "./github-link.ts";

const network = vi.hoisted(() => {
  type StoredEvent = {
    createdAt: string;
    offset: number;
    payload: Record<string, unknown>;
    type: string;
  };
  const streams = new Map<string, StoredEvent[]>();
  const repoCalls: Array<{ args: unknown[]; method: string; name: string }> = [];
  const state = {
    githubLink: null as Record<string, unknown> | null,
    /** What the fake GitHub API answers: repo exists / missing / create fails. */
    githubRepoExists: true,
    githubCreateStatus: 201,
    pushShouldFail: false,
    configureLinkShouldFail: false,
    subscriptionRemoveAppendShouldFail: false,
  };

  function streamEvents(name: string): StoredEvent[] {
    let events = streams.get(name);
    if (!events) {
      events = [];
      streams.set(name, events);
    }
    return events;
  }

  return {
    repoCalls,
    reset() {
      streams.clear();
      repoCalls.length = 0;
      state.githubLink = null;
      state.githubRepoExists = true;
      state.githubCreateStatus = 201;
      state.pushShouldFail = false;
      state.configureLinkShouldFail = false;
      state.subscriptionRemoveAppendShouldFail = false;
    },
    seedStream(name: string, ...events: Array<{ payload: Record<string, unknown>; type: string }>) {
      const stored = streamEvents(name);
      for (const event of events) {
        stored.push({ ...event, createdAt: new Date().toISOString(), offset: stored.length + 1 });
      }
    },
    state,
    streams,
    STREAM: {
      getByName(name: string) {
        const stored = streamEvents(name);
        return {
          async append(...inputs: Array<{ payload: Record<string, unknown>; type: string }>) {
            for (const input of inputs) {
              if (
                network.state.subscriptionRemoveAppendShouldFail &&
                input.type === "events.iterate.com/stream/subscription-removed"
              ) {
                throw new Error("subscription-removed append exploded");
              }
              stored.push({
                ...input,
                createdAt: new Date().toISOString(),
                offset: stored.length + 1,
              });
            }
            return inputs;
          },
          async getEvents(args: { afterOffset?: number; beforeOffset?: number }) {
            const after = args.afterOffset ?? 0;
            const before = args.beforeOffset ?? Number.MAX_SAFE_INTEGER;
            return stored.filter((event) => event.offset > after && event.offset < before);
          },
          async runtimeState() {
            return { coreProcessorState: { maxOffset: stored.length } };
          },
        };
      },
    },
    // The connection secret's fetch IS the fake GitHub API: the wrapped
    // Octokit dispatches every request through it.
    SECRET: {
      getByName(_name: string) {
        return {
          async fetch(request: Request) {
            const url = new URL(request.url);
            if (request.method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
              if (network.state.githubRepoExists) {
                return Response.json({ default_branch: "main", full_name: "acme/widgets" });
              }
              return Response.json({ message: "Not Found" }, { status: 404 });
            }
            if (request.method === "POST" && /^\/orgs\/[^/]+\/repos$/.test(url.pathname)) {
              if (network.state.githubCreateStatus === 422) {
                // What real GitHub answers when the name is taken — the shape
                // the exists-but-not-selected detection keys off.
                return Response.json(
                  {
                    errors: [
                      {
                        code: "custom",
                        field: "name",
                        message: "name already exists on this account",
                        resource: "Repository",
                      },
                    ],
                    message: "Repository creation failed.",
                  },
                  { status: 422 },
                );
              }
              if (network.state.githubCreateStatus !== 201) {
                return Response.json(
                  { message: "Resource not accessible by integration" },
                  { status: network.state.githubCreateStatus },
                );
              }
              return Response.json({ full_name: "acme/widgets", private: true }, { status: 201 });
            }
            return Response.json(
              { message: `unexpected ${request.method} ${url.pathname}` },
              { status: 500 },
            );
          },
        };
      },
    },
    REPO: {
      getByName(name: string) {
        return {
          // Read-only probe, deliberately not recorded in repoCalls: the
          // ordering assertions track the mutating verbs.
          async getGithubLink() {
            return network.state.githubLink;
          },
          async configureGithubLink(link: Record<string, unknown>) {
            if (network.state.configureLinkShouldFail) throw new Error("link write exploded");
            network.state.githubLink = link;
            network.repoCalls.push({ args: [link], method: "configureGithubLink", name });
            return link;
          },
          async removeGithubLink() {
            const removed = network.state.githubLink;
            network.state.githubLink = null;
            network.repoCalls.push({ args: [], method: "removeGithubLink", name });
            return removed;
          },
          async pushToGithub(input: { force?: boolean }) {
            network.repoCalls.push({ args: [input], method: "pushToGithub", name });
            if (network.state.pushShouldFail) throw new Error("github push exploded");
            return { branch: "main", commitOid: "abc123" };
          },
        };
      },
    },
  };
});

// connect-flows imports slack-api (disconnect's auth.revoke) and telegram-api
// (disconnect's deleteWebhook), which drag the worker-only egress entrypoint
// into the module graph; sever those edges — these tests never touch either.
// Same seam as github-connect.test.ts.
vi.mock("../integrations/slack-api.ts", () => ({ callProjectSlackWebApi: vi.fn() }));
vi.mock("../integrations/telegram-api.ts", () => ({
  callProjectTelegramBotApi: vi.fn(),
  telegramApiBaseUrl: (config: { integrations: { telegram: { apiBaseUrl: string } } }) =>
    config.integrations.telegram.apiBaseUrl.replace(/\/$/, ""),
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    REPO: network.REPO,
    SECRET: network.SECRET,
    STREAM: network.STREAM,
  },
}));

const PROJECT_ID = "prj_test";
const CONNECTION = "install-789";
const CONNECTION_STREAM = DurableObjectNameCodec.stringify({
  projectId: PROJECT_ID,
  path: `/integrations/github/${CONNECTION}`,
});

function seedConnectedFact() {
  network.seedStream(CONNECTION_STREAM, {
    type: GITHUB_CONNECTED_EVENT_TYPE,
    payload: {
      connection: CONNECTION,
      externalId: "789",
      installationId: "789",
      projectId: PROJECT_ID,
    },
  });
}

function linkInput() {
  return {
    connection: CONNECTION,
    owner: "acme",
    projectId: PROJECT_ID,
    repo: "widgets",
    repoPath: "/repos/project",
  };
}

describe("linkRepoToGithub", () => {
  afterEach(() => {
    network.reset();
  });

  test("links an existing GitHub repo: records the link, installs the webhook subscription, seeds the mirror", async () => {
    seedConnectedFact();

    const result = await linkRepoToGithub(linkInput());
    expect(result).toEqual({
      connection: CONNECTION,
      created: false,
      initialPush: { commitOid: "abc123", ok: true },
      installationId: "789",
      owner: "acme",
      repo: "widgets",
    });

    // The Repo DO recorded the link before the initial push ran.
    expect(network.repoCalls.map((call) => call.method)).toEqual([
      "configureGithubLink",
      "pushToGithub",
    ]);

    // The cross-post push subscription on the connection stream: GitHub
    // webhooks about exactly this repository copy onto the repo's own stream
    // via its `ingest` sink.
    const subscription = network.streams
      .get(CONNECTION_STREAM)
      ?.find((event) => event.type === "events.iterate.com/stream/subscription-configured");
    expect(subscription?.payload).toEqual({
      subscriptionKey: "github-repo:/repos/project",
      selector: {
        condition: 'payload.body.repository.full_name = "acme/widgets"',
        eventTypes: ["events.iterate.com/github/webhook-received"],
      },
      delivery: {
        mode: "push",
        expression: ["streams", ["get", "/repos/project"], "ingest"],
      },
      deliver: "new",
    });
  });

  test("creates the GitHub repo (private, in-org) when it does not exist", async () => {
    seedConnectedFact();
    network.state.githubRepoExists = false;

    const result = await linkRepoToGithub(linkInput());
    expect(result.created).toBe(true);
  });

  test("surfaces an actionable error when the repo is missing and cannot be created", async () => {
    seedConnectedFact();
    network.state.githubRepoExists = false;
    network.state.githubCreateStatus = 403;

    await expect(linkRepoToGithub(linkInput())).rejects.toThrow(/could not be created/);
    // Nothing was linked and no subscription was installed.
    expect(network.repoCalls).toEqual([]);
    expect(
      network.streams
        .get(CONNECTION_STREAM)
        ?.some((event) => event.type === "events.iterate.com/stream/subscription-configured"),
    ).toBe(false);
  });

  test("names the real cause when the repo exists but the installation cannot see it", async () => {
    seedConnectedFact();
    // GET /repos 404s (unselected repos are invisible to the installation)
    // while the create 422s on the taken name — the exists-but-no-access case.
    network.state.githubRepoExists = false;
    network.state.githubCreateStatus = 422;

    await expect(linkRepoToGithub(linkInput())).rejects.toThrow(
      /exists, but connection "install-789" \(App installation 789\) has no access to it.*github\.com\/organizations\/acme\/settings\/installations\/789/,
    );
    // Nothing was linked and no subscription was installed.
    expect(network.repoCalls).toEqual([]);
    expect(
      network.streams
        .get(CONNECTION_STREAM)
        ?.some((event) => event.type === "events.iterate.com/stream/subscription-configured"),
    ).toBe(false);
  });

  test("a failed initial push does not fail the link", async () => {
    seedConnectedFact();
    network.state.pushShouldFail = true;

    const result = await linkRepoToGithub(linkInput());
    expect(result.initialPush.ok).toBe(false);
    expect(result.initialPush.error).toMatch(/github push exploded/);
    expect(network.state.githubLink).not.toBeNull();
  });

  test("refuses when the connection is not connected", async () => {
    await expect(linkRepoToGithub(linkInput())).rejects.toThrow(/is not connected/);
  });

  test("rolls the webhook subscription back when recording the link fails", async () => {
    seedConnectedFact();
    network.state.configureLinkShouldFail = true;

    await expect(linkRepoToGithub(linkInput())).rejects.toThrow(/link write exploded/);

    // The subscription that went in ahead of the link write was compensated
    // away, so a failed link leaves neither a link nor a live subscription
    // behind.
    const connectionEvents = network.streams.get(CONNECTION_STREAM) ?? [];
    expect(
      connectionEvents.filter(
        (e) => e.type === "events.iterate.com/stream/subscription-configured",
      ),
    ).toHaveLength(1);
    const removed = connectionEvents.find(
      (e) => e.type === "events.iterate.com/stream/subscription-removed",
    );
    expect(removed?.payload).toEqual({ subscriptionKey: "github-repo:/repos/project" });
    expect(network.state.githubLink).toBeNull();
  });

  test("re-linking through a different connection removes the old connection's subscription", async () => {
    seedConnectedFact();
    await linkRepoToGithub(linkInput());

    const otherConnection = "install-456";
    const otherConnectionStream = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: `/integrations/github/${otherConnection}`,
    });
    network.seedStream(otherConnectionStream, {
      type: GITHUB_CONNECTED_EVENT_TYPE,
      payload: {
        connection: otherConnection,
        externalId: "456",
        installationId: "456",
        projectId: PROJECT_ID,
      },
    });

    // A failed old-subscription removal aborts the re-link BEFORE anything
    // changes: the link still names the old connection and a retry starts clean.
    network.state.subscriptionRemoveAppendShouldFail = true;
    await expect(linkRepoToGithub({ ...linkInput(), connection: otherConnection })).rejects.toThrow(
      /subscription-removed append exploded/,
    );
    expect(network.state.githubLink).toMatchObject({ connection: CONNECTION });
    network.state.subscriptionRemoveAppendShouldFail = false;

    await linkRepoToGithub({ ...linkInput(), connection: otherConnection });

    // The new connection stream holds the subscription; the old one got the
    // removal.
    const newSubscription = network.streams
      .get(otherConnectionStream)
      ?.find((e) => e.type === "events.iterate.com/stream/subscription-configured");
    expect(newSubscription?.payload).toMatchObject({
      subscriptionKey: "github-repo:/repos/project",
    });
    const oldRemoved = network.streams
      .get(CONNECTION_STREAM)
      ?.find((e) => e.type === "events.iterate.com/stream/subscription-removed");
    expect(oldRemoved?.payload).toEqual({ subscriptionKey: "github-repo:/repos/project" });
    expect(network.state.githubLink).toMatchObject({ connection: otherConnection });
  });

  test("a failed re-link restores the previous connection's subscription", async () => {
    seedConnectedFact();
    await linkRepoToGithub(linkInput());

    const otherConnection = "install-456";
    const otherConnectionStream = DurableObjectNameCodec.stringify({
      projectId: PROJECT_ID,
      path: `/integrations/github/${otherConnection}`,
    });
    network.seedStream(otherConnectionStream, {
      type: GITHUB_CONNECTED_EVENT_TYPE,
      payload: {
        connection: otherConnection,
        externalId: "456",
        installationId: "456",
        projectId: PROJECT_ID,
      },
    });

    // The old subscription is removed first; when recording the new link then
    // fails, the compensation must put the OLD connection's subscription back
    // so the still-recorded old link keeps its webhook lane.
    network.state.configureLinkShouldFail = true;
    await expect(linkRepoToGithub({ ...linkInput(), connection: otherConnection })).rejects.toThrow(
      /link write exploded/,
    );
    expect(network.state.githubLink).toMatchObject({ connection: CONNECTION });

    const oldStreamEvents = network.streams.get(CONNECTION_STREAM) ?? [];
    const lastSubscriptionFact = [...oldStreamEvents]
      .reverse()
      .find(
        (e) =>
          e.type === "events.iterate.com/stream/subscription-configured" ||
          e.type === "events.iterate.com/stream/subscription-removed",
      );
    // The restore (a subscription-configured) landed AFTER the removal.
    expect(lastSubscriptionFact?.type).toBe("events.iterate.com/stream/subscription-configured");
    expect(lastSubscriptionFact?.payload).toMatchObject({
      subscriptionKey: "github-repo:/repos/project",
      selector: { condition: 'payload.body.repository.full_name = "acme/widgets"' },
    });
  });
});

describe("unlinkRepoFromGithub", () => {
  afterEach(() => {
    network.reset();
  });

  test("removes the link and the webhook subscription", async () => {
    seedConnectedFact();
    await linkRepoToGithub(linkInput());

    const result = await unlinkRepoFromGithub({
      projectId: PROJECT_ID,
      repoPath: "/repos/project",
    });
    expect(result).toEqual({ unlinked: true });
    const removed = network.streams
      .get(CONNECTION_STREAM)
      ?.find((event) => event.type === "events.iterate.com/stream/subscription-removed");
    expect(removed?.payload).toEqual({ subscriptionKey: "github-repo:/repos/project" });
  });

  test("unlinking an unlinked repo is a no-op", async () => {
    const result = await unlinkRepoFromGithub({
      projectId: PROJECT_ID,
      repoPath: "/repos/project",
    });
    expect(result).toEqual({ unlinked: false });
  });

  test("a failed subscription removal keeps the link so unlink stays retryable", async () => {
    seedConnectedFact();
    await linkRepoToGithub(linkInput());

    network.state.subscriptionRemoveAppendShouldFail = true;
    await expect(
      unlinkRepoFromGithub({ projectId: PROJECT_ID, repoPath: "/repos/project" }),
    ).rejects.toThrow(/subscription-removed append exploded/);
    // The link is still in place — the subscription is removed BEFORE the
    // link, so a failure leaves a retryable state, never an orphaned
    // subscription with no link.
    expect(network.state.githubLink).not.toBeNull();

    network.state.subscriptionRemoveAppendShouldFail = false;
    const retried = await unlinkRepoFromGithub({
      projectId: PROJECT_ID,
      repoPath: "/repos/project",
    });
    expect(retried).toEqual({ unlinked: true });
    expect(network.state.githubLink).toBeNull();
  });
});
