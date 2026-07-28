import { expect, test, vi } from "vitest";
import type { StreamEvent } from "../../sdk.ts";
import { GithubAiLinter } from "./index.ts";

test("the project worker handles verified GitHub webhooks directly", async () => {
  const dispose = vi.fn();
  const append = vi.fn(async () => []);
  const runtimeState = vi.fn(async () => ({
    coreProcessorState: {
      subscriptions: {
        outbound: { byKey: { "app-review-bot#review-bot": {} } },
      },
    },
  }));
  const get = vi.fn(async () => ({
    [Symbol.dispose]: dispose,
    streams: { get: vi.fn(() => ({ append, runtimeState })) },
  }));
  const app = GithubAiLinter.create({ ITX: { get } } as never, {
    policyVersion: "2",
    rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
  });

  await app.processEvent({
    ...event("events.iterate.com/github/webhook-received"),
    source: {
      copiedFrom: [
        {
          createdAt: "2026-07-28T12:00:00.000Z",
          cursorChangedAtSourceOffset: 1,
          offset: 1,
          path: "/integrations/github/install-42",
          projectId: "prj_1",
          streamCreatedAt: "2026-07-28T12:00:00.000Z",
          streamId: "11111111-1111-4111-8111-111111111111",
          subscriptionKey: "copy",
          type: "events.iterate.com/github/webhook-received",
        },
      ],
    },
  });
  expect(get).not.toHaveBeenCalled();

  await app.processEvent({
    ...event("events.iterate.com/repo/github-link-configured"),
    payload: { connection: "install-42" },
  });
  expect(append).toHaveBeenCalledWith({
    type: "events.iterate.com/stream/subscription-removed",
    idempotencyKey: "github-ai-linter:retire-hosted-review-bot:v1",
    payload: {
      subscriptionKey: "app-review-bot#review-bot",
      reason: "requested",
    },
  });

  await app.processEvent(event("events.iterate.com/github/webhook-received"));
  expect(get).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(2);
});

test("a project without the retired hosted subscription links normally", async () => {
  const append = vi.fn(async () => []);
  const get = vi.fn(async () => ({
    [Symbol.dispose]: vi.fn(),
    streams: {
      get: vi.fn(() => ({
        append,
        runtimeState: vi.fn(async () => ({
          coreProcessorState: { subscriptions: { outbound: { byKey: {} } } },
        })),
      })),
    },
  }));
  const app = GithubAiLinter.create({ ITX: { get } } as never, {
    policyVersion: "2",
    rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
  });

  await expect(
    app.processEvent({
      ...event("events.iterate.com/repo/github-link-configured"),
      payload: { connection: "install-42" },
    }),
  ).resolves.toBeUndefined();
  expect(append).not.toHaveBeenCalled();
});

function event(type: string): StreamEvent {
  return {
    createdAt: "2026-07-28T12:00:00.000Z",
    offset: 1,
    path: "/integrations/github/install-42",
    payload: {},
    type,
  };
}
