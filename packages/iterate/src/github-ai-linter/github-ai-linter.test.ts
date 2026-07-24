import { expect, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "../sdk.ts";
import { GithubAiLinter } from "./index.ts";

test("a declared GitHub AI linter subscribes each linked connection without config-owned plumbing", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create(
    projectEnv((path, ...events) => appended.push({ events, path })),
    {
      policyVersion: "2",
      rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
    },
  );

  await app.processEvent({
    ...githubLinkConfigured("ignored"),
    type: "events.iterate.com/project/heartbeat",
  });
  await app.processEvent({ ...githubLinkConfigured("ignored"), payload: { connection: "" } });
  await app.processEvent(githubLinkConfigured("iterate-installation"));

  expect(appended).toMatchObject([
    {
      path: "/integrations/github/iterate-installation",
      events: [
        {
          idempotencyKey: "review-bot/subscription:v4",
          payload: {
            delivery: {
              mode: "wake",
              expression: [
                "workers",
                [
                  "get",
                  {
                    className: "ReviewBotApp",
                    durableWorkerKey: "app-review-bot-iterate--installation",
                    path: "/",
                    type: "stateful",
                  },
                ],
                "processor",
                "wakeStreamSubscriber",
              ],
              processorSlug: "review-bot",
            },
            subscriptionKey: "app-review-bot#review-bot",
          },
          type: "events.iterate.com/stream/subscription-configured",
        },
      ],
    },
  ]);
  const subscription: any = appended[0]?.events[0];
  const ref: any = subscription.payload.delivery.expression[1][1];
  expect(ref).toMatchObject({
    source: {
      createWorker: {
        entryPoint: "node_modules/iterate/dist/github-ai-linter/configured-worker.mjs",
        files: {
          include: ["package.json"],
          repoPath: "/repos/config",
          type: "repo",
        },
      },
    },
  });
  const virtualConfig = ref.source.createWorker.virtualModules["iterate:github-ai-linter-config"];
  expect(virtualConfig).toContain('"policyVersion":"2"');
  expect(virtualConfig).toContain('"glob":"rules/**/*.md"');
  expect(virtualConfig).toContain('"repoPath":"/repos/iterate"');
});

test("connection slugs with underscores produce distinct runtime-valid durable keys", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create(
    projectEnv((path, ...events) => appended.push({ events, path })),
    {
      policyVersion: "2",
      rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
    },
  );

  await app.processEvent(githubLinkConfigured("install-42-a_b"));
  await app.processEvent(githubLinkConfigured("install-42-a-ub"));

  const durableWorkerKeys = appended.map((append) => {
    const subscription: any = append.events[0];
    return subscription.payload.delivery.expression[1][1].durableWorkerKey;
  });
  expect(durableWorkerKeys).toEqual([
    "app-review-bot-install--42--a-ub",
    "app-review-bot-install--42--a--ub",
  ]);
});

function githubLinkConfigured(connection: string): StreamEvent {
  return {
    createdAt: "2026-07-22T12:00:00.000Z",
    offset: 1,
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
