// Unit tests for the pull-request agent lane: the repo processor's PR webhook
// forward (router) and the github-pr-agent processor (transcriber), plus the
// path scheme. Same in-memory stream network harness as the email/slack
// processor tests — no Durable Objects, no network.

import { describe, expect, it } from "vitest";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import { RepoProcessor } from "./repo-processor-implementation.ts";
import { PrAgentProcessor } from "./pr-agent-processor-implementation.ts";
import {
  isPrAgentPath,
  prAgentPath,
  pullRequestNumberFromWebhookBody,
  repoSlugForAgentPath,
} from "./pr-agent-utils.ts";

/**
 * In-memory network of streams keyed by path, so router tests can observe the
 * cross-stream forwards (`stream.at(path).append(...)`) next to same-stream
 * appends. Mirrors email-processors.test.ts.
 */
class MemoryStreamNetwork {
  readonly streams = new Map<string, MemoryStream>();

  get(path: string): MemoryStream {
    let stream = this.streams.get(path);
    if (stream === undefined) {
      stream = new MemoryStream(this, path);
      this.streams.set(path, stream);
    }
    return stream;
  }

  eventsAt(path: string): StreamEvent[] {
    return this.streams.get(path)?.events ?? [];
  }
}

class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  constructor(
    readonly network: MemoryStreamNetwork,
    readonly path: string,
  ) {}

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
        path: this.path,
      };
      this.events.push(event);
      return event;
    });
  }

  at(path: string): Stream {
    return this.network.get(path);
  }

  async getEvent(): Promise<StreamEvent | undefined> {
    return undefined;
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    const beforeOffset = input.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.events
      .filter((event) => event.offset > afterOffset)
      .filter((event) => event.offset < beforeOffset)
      .filter(
        (event) =>
          input.eventTypes === undefined ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(): Promise<StreamEvent> {
    throw new Error("MemoryStream does not implement waitForEvent().");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {}, workerDelivery: null } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }
}

type ProcessorLike = {
  ingest(input: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

async function deliverNewEvents(input: {
  cursors: Map<object, number>;
  processor: ProcessorLike;
  stream: MemoryStream;
}) {
  const cursor = input.cursors.get(input.processor) ?? 0;
  const events = input.stream.events.slice(cursor);
  input.cursors.set(input.processor, input.stream.events.length);
  if (events.length === 0) return;
  await input.processor.ingest({ events, streamMaxOffset: input.stream.events.length });
}

const GITHUB_LINK = {
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
};

/** One captured GitHub webhook delivery, in the connection-stream envelope. */
function webhookPayload(body: Record<string, unknown>): Record<string, unknown> {
  return { body, headers: { "content-type": "application/json" }, installationId: "789" };
}

function pullRequestBody(input: {
  action?: string;
  comment?: { body: string; senderLogin?: string; senderType?: string };
  number?: number;
  title?: string;
}): Record<string, unknown> {
  const number = input.number ?? 7;
  return {
    action: input.action ?? (input.comment === undefined ? "opened" : "created"),
    ...(input.comment === undefined
      ? {
          pull_request: {
            number,
            title: input.title ?? "Add widgets",
            state: "open",
            draft: false,
            head: { ref: "feature" },
            base: { ref: "main" },
            body: "PR description",
          },
        }
      : {
          issue: { number, title: input.title ?? "Add widgets", pull_request: { url: "x" } },
          comment: { body: input.comment.body, html_url: "https://github.com/x" },
        }),
    sender: {
      login: input.comment?.senderLogin ?? "jonas",
      type: input.comment?.senderType ?? "User",
    },
    repository: { full_name: "acme/widgets" },
  };
}

function newRepoProcessor(stream: MemoryStream, path = "/") {
  return new RepoProcessor({
    stream,
    createRepoArtifact: async () => {
      throw new Error("not under test");
    },
    path,
    projectId: "prj_1",
  });
}

describe("pr-agent path scheme", () => {
  it("derives slugs and paths", () => {
    expect(repoSlugForAgentPath("/")).toBe("root");
    expect(repoSlugForAgentPath("/repos/foo")).toBe("foo");
    expect(repoSlugForAgentPath("/tools/bar")).toBe("tools-bar");
    expect(prAgentPath("/", 7)).toBe("/agents/repos/root/pull-requests/7");
    expect(prAgentPath("/repos/foo", 12)).toBe("/agents/repos/foo/pull-requests/12");
    expect(() => prAgentPath("/", 0)).toThrow(/positive integer/);
  });

  it("recognizes PR agent paths and only those", () => {
    expect(isPrAgentPath("/agents/repos/root/pull-requests/7")).toBe(true);
    expect(isPrAgentPath("/agents/repos/foo/pull-requests/12")).toBe(true);
    expect(isPrAgentPath("/agents/repos/foo/pull-requests/nope")).toBe(false);
    expect(isPrAgentPath("/agents/repos/pull-requests/7")).toBe(false);
    expect(isPrAgentPath("/agents/email/t1")).toBe(false);
    expect(isPrAgentPath("/agents/onboarding")).toBe(false);
  });

  it("extracts PR numbers from the webhook shapes that carry them", () => {
    expect(pullRequestNumberFromWebhookBody(pullRequestBody({ number: 42 }))).toBe(42);
    expect(
      pullRequestNumberFromWebhookBody(pullRequestBody({ comment: { body: "hi" }, number: 9 })),
    ).toBe(9);
    // A plain issue comment (no issue.pull_request) is not a PR event.
    expect(
      pullRequestNumberFromWebhookBody({
        action: "created",
        issue: { number: 3 },
        comment: { body: "hi" },
      }),
    ).toBeNull();
    // Push webhooks carry neither shape.
    expect(pullRequestNumberFromWebhookBody({ ref: "refs/heads/main", after: "abc" })).toBeNull();
    expect(pullRequestNumberFromWebhookBody(null)).toBeNull();
    expect(pullRequestNumberFromWebhookBody("push")).toBeNull();
  });
});

describe("RepoProcessor PR webhook forward (router)", () => {
  it("forwards PR webhooks to the per-PR agent stream, route fact first", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network.eventsAt("/agents/repos/root/pull-requests/7");
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/github-pr/route-configured",
      "events.iterate.com/github/webhook-received",
    ]);
    expect(routed[0]!.payload).toEqual({
      ...GITHUB_LINK,
      number: 7,
      repoPath: "/",
      streamPath: "/agents/repos/root/pull-requests/7",
    });
    expect(routed[1]!.payload).toEqual(webhookPayload(pullRequestBody({ number: 7 })));
  });

  it("routes each PR to its own stream and dedupes the route fact per PR", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ comment: { body: "nice" }, number: 7 })),
      },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 8 })),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    const pr7 = network.eventsAt("/agents/repos/root/pull-requests/7");
    expect(pr7.map((event) => event.type)).toEqual([
      "events.iterate.com/github-pr/route-configured",
      "events.iterate.com/github/webhook-received",
      "events.iterate.com/github/webhook-received",
    ]);
    const pr8 = network.eventsAt("/agents/repos/root/pull-requests/8");
    expect(pr8.map((event) => event.type)).toEqual([
      "events.iterate.com/github-pr/route-configured",
      "events.iterate.com/github/webhook-received",
    ]);
  });

  it("relinking to a different GitHub repo emits a fresh route fact that repoints the agent", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
      // Relink: same repo path now mirrors a different GitHub repository.
      {
        type: "events.iterate.com/repo/github-link-configured",
        payload: { ...GITHUB_LINK, repo: "gadgets" },
      },
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    // A coordinate-free key would dedupe the second route fact into the stale
    // acme/widgets coordinates; the coordinate-carrying key repoints instead.
    const routeFacts = network
      .eventsAt("/agents/repos/root/pull-requests/7")
      .filter((event) => event.type === "events.iterate.com/github-pr/route-configured");
    expect(routeFacts).toHaveLength(2);
    expect(routeFacts[0]!.payload).toMatchObject({ repo: "widgets" });
    expect(routeFacts[1]!.payload).toMatchObject({ repo: "gadgets" });
  });

  it("ignores non-PR webhooks and webhooks on unlinked repos", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/");
    const processor = newRepoProcessor(stream);
    const cursors = new Map<object, number>();

    await stream.append(
      // Not linked yet: even a PR webhook has nowhere to route (no github state).
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7 })),
      },
      { type: "events.iterate.com/repo/github-link-configured", payload: GITHUB_LINK },
      // Linked, but a push webhook is repo context, not PR conversation.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload({ ref: "refs/heads/main", after: "abc123" }),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    expect(network.streams.size).toBe(1);
  });
});

describe("PrAgentProcessor (transcriber)", () => {
  const AGENT_PATH = "/agents/repos/root/pull-requests/7";
  const ROUTE_EVENT = {
    type: "events.iterate.com/github-pr/route-configured" as const,
    payload: { ...GITHUB_LINK, number: 7, repoPath: "/", streamPath: AGENT_PATH },
  };

  function agentInputs(stream: MemoryStream) {
    return stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added");
  }

  it("transcribes the route fact into silent context naming the reply door", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(AGENT_PATH);
    const processor = new PrAgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append(ROUTE_EVENT);
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = agentInputs(stream);
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: object };
    expect(payload.content).toContain("pull request #7 of acme/widgets");
    expect(payload.content).toContain('itx.integrations.github["install-789"]');
    expect(payload.content).toContain("createComment");
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "dont-trigger-request" });
    expect(processor.state).toMatchObject({ number: 7, owner: "acme", repo: "widgets" });
  });

  it("triggers a turn only for human comments that mention the agent", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(AGENT_PATH);
    const processor = new PrAgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append(
      ROUTE_EVENT,
      // PR opened: context only.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ number: 7, title: "Add widgets" })),
      },
      // Human comment without a mention: context only.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(pullRequestBody({ comment: { body: "lgtm" }, number: 7 })),
      },
      // Human comment mentioning the agent: this one wakes the LLM.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(
          pullRequestBody({ comment: { body: "@iterate what does this change?" }, number: 7 }),
        ),
      },
      // The agent's own comment boomerangs back with a Bot sender: never a trigger.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(
          pullRequestBody({
            comment: {
              body: "@iterate here is my analysis",
              senderLogin: "iterate[bot]",
              senderType: "Bot",
            },
            number: 7,
          }),
        ),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = agentInputs(stream);
    // route context + 4 webhooks
    expect(inputs).toHaveLength(5);
    const policies = inputs.map(
      (event) => (event.payload as { llmRequestPolicy?: { behaviour: string } }).llmRequestPolicy,
    );
    expect(policies[1]).toEqual({ behaviour: "dont-trigger-request" });
    expect(policies[2]).toEqual({ behaviour: "dont-trigger-request" });
    // The mention triggers: the omitted policy materializes as the schema
    // default, which is the turn-triggering behaviour.
    expect(policies[3]).toEqual({ behaviour: "after-current-request" });
    expect(policies[4]).toEqual({ behaviour: "dont-trigger-request" });

    const mentionInput = inputs[3]!.payload as { content: string };
    expect(mentionInput.content).toContain("@iterate what does this change?");
    const openedInput = inputs[1]!.payload as { content: string };
    expect(openedInput.content).toContain("Add widgets");
  });

  it("gates triggers on action, mention boundary, and PR-description mentions", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(AGENT_PATH);
    const processor = new PrAgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append(
      ROUTE_EVENT,
      // Deleting (or editing) a mention comment must not wake the agent —
      // GitHub sends the full body on both actions.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload({
          ...pullRequestBody({ comment: { body: "@iterate please review" }, number: 7 }),
          action: "deleted",
        }),
      },
      // An email address is not a mention.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload(
          pullRequestBody({ comment: { body: "mail support@iterate.com about this" }, number: 7 }),
        ),
      },
      // A mention in the PR description triggers on open…
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload({
          ...pullRequestBody({ number: 7 }),
          pull_request: {
            ...(pullRequestBody({ number: 7 }).pull_request as object),
            body: "@iterate please review this",
          },
        }),
      },
      // …but not on later pull_request actions that still carry the body.
      {
        type: "events.iterate.com/github/webhook-received",
        payload: webhookPayload({
          ...pullRequestBody({ number: 7 }),
          action: "synchronize",
          pull_request: {
            ...(pullRequestBody({ number: 7 }).pull_request as object),
            body: "@iterate please review this",
          },
        }),
      },
    );
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = agentInputs(stream);
    expect(inputs).toHaveLength(5);
    const policies = inputs.map(
      (event) => (event.payload as { llmRequestPolicy?: { behaviour: string } }).llmRequestPolicy,
    );
    expect(policies[1]).toEqual({ behaviour: "dont-trigger-request" }); // deleted mention
    expect(policies[2]).toEqual({ behaviour: "dont-trigger-request" }); // email address
    expect(policies[3]).toEqual({ behaviour: "after-current-request" }); // description mention on open
    expect(policies[4]).toEqual({ behaviour: "dont-trigger-request" }); // synchronize
  });

  it("a relink's fresh route fact produces a fresh, corrected route-context input", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get(AGENT_PATH);
    const processor = new PrAgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append(ROUTE_EVENT, {
      ...ROUTE_EVENT,
      payload: { ...ROUTE_EVENT.payload, repo: "gadgets" },
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = agentInputs(stream).map(
      (event) => (event.payload as { content: string }).content,
    );
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain("acme/widgets");
    expect(inputs[1]).toContain("acme/gadgets");
    expect(processor.state).toMatchObject({ repo: "gadgets" });
  });
});
