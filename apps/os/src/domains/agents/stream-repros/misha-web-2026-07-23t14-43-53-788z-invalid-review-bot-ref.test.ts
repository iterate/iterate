import { GithubAiLinter } from "iterate/github-ai-linter";
import type { StreamEvent, StreamEventInput } from "iterate/sdk";
import { expect, test } from "vitest";
import { DynamicWorkerRef } from "../../workers/schemas.ts";
import fixture from "./misha-web-2026-07-23t14-43-53-788z-invalid-review-bot-ref.fixture.json";

test("re-linking the packaged linter replaces Misha's rejected subscription with a valid worker ref", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create({
    policyVersion: "1",
    rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
  });

  await app.processEvent(
    githubLinkConfigured(fixture.connection),
    projectEnv((path, ...events) => appended.push({ events, path })),
  );

  const subscription: any = appended[0]?.events[0];
  const ref = subscription.payload.delivery.expression[1][1];
  expect({
    idempotencyKeyChanged:
      subscription.idempotencyKey !== fixture.existingSubscription.idempotencyKey,
    workerRef: DynamicWorkerRef.safeParse(ref),
  }).toMatchObject({
    idempotencyKeyChanged: true,
    workerRef: { success: true },
  });
});

function githubLinkConfigured(connection: string): StreamEvent {
  return {
    createdAt: "2026-07-23T14:49:58.078Z",
    offset: 42,
    path: "/",
    payload: { connection },
    type: "events.iterate.com/repo/github-link-configured",
  };
}

function projectEnv(append: (path: string, ...events: StreamEventInput[]) => void): any {
  return {
    ITX: {
      get: async () => ({
        [Symbol.dispose]() {},
        streams: {
          get: (path: string) => ({
            append: async (...events: StreamEventInput[]) => append(path, ...events),
          }),
        },
      }),
    },
  };
}
