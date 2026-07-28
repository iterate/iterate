import { expect, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "../../sdk.ts";
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
    ...githubLinkConfigured("ignored", 1),
    type: "events.iterate.com/project/heartbeat",
  });
  await app.processEvent({ ...githubLinkConfigured("ignored", 2), payload: { connection: "" } });
  await app.processEvent(githubLinkConfigured("iterate-installation", 3));

  expect(appended).toMatchObject([
    {
      path: "/integrations/github/iterate-installation",
      events: [
        {
          idempotencyKey: "review-bot/subscription:v4:/:3",
          payload: {
            receiver: {
              action: "processor-wake",
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
                "wakeStreamProcessor",
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
  const ref: any = subscription.payload.receiver.expression[1][1];
  expect(ref).toMatchObject({
    source: {
      createWorker: {
        entryPoint: "node_modules/iterate/dist/starter-apps/github-ai-linter/configured-worker.mjs",
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

test("each link event can replace the stable subscription, including a config rollback", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const env = projectEnv((path, ...events) => appended.push({ events, path }));

  await GithubAiLinter.create(env, {
    policyVersion: "2",
    rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
  }).processEvent(githubLinkConfigured("iterate-installation", 41));
  await GithubAiLinter.create(env, {
    policyVersion: "3",
    rules: { glob: "review-rules/**/*.md", repoPath: "/repos/product" },
  }).processEvent(githubLinkConfigured("iterate-installation", 42));
  await GithubAiLinter.create(env, {
    policyVersion: "2",
    rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
  }).processEvent(githubLinkConfigured("iterate-installation", 43));

  expect(
    appended.map(({ events }) => ({
      idempotencyKey: events[0]?.idempotencyKey,
      subscriptionKey: events[0]?.payload?.subscriptionKey,
    })),
  ).toEqual([
    {
      idempotencyKey: "review-bot/subscription:v4:/:41",
      subscriptionKey: "app-review-bot#review-bot",
    },
    {
      idempotencyKey: "review-bot/subscription:v4:/:42",
      subscriptionKey: "app-review-bot#review-bot",
    },
    {
      idempotencyKey: "review-bot/subscription:v4:/:43",
      subscriptionKey: "app-review-bot#review-bot",
    },
  ]);
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

  await app.processEvent(githubLinkConfigured("install-42-a_b", 1));
  await app.processEvent(githubLinkConfigured("install-42-a-ub", 2));

  const durableWorkerKeys = appended.map((append) => {
    const subscription: any = append.events[0];
    return subscription.payload.receiver.expression[1][1].durableWorkerKey;
  });
  expect(durableWorkerKeys).toEqual([
    "app-review-bot-install--42--a-ub",
    "app-review-bot-install--42--a--ub",
  ]);
});

function githubLinkConfigured(connection: string, offset: number): StreamEvent {
  return {
    createdAt: "2026-07-22T12:00:00.000Z",
    offset,
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
