import { expect, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "../sdk.ts";
import { dispatchProjectApps } from "../project-apps.ts";
import { GithubAiLinter } from "./index.ts";

test("a declared GitHub AI linter subscribes each linked connection without config-owned plumbing", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create({
    policyVersion: "2",
    rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
  });

  await app.processEvent(
    { ...githubLinkConfigured("ignored"), type: "events.iterate.com/project/heartbeat" },
    projectEnv((path, ...events) => appended.push({ events, path })),
  );
  await app.processEvent(
    { ...githubLinkConfigured("ignored"), payload: { connection: "" } },
    projectEnv((path, ...events) => appended.push({ events, path })),
  );
  await app.processEvent(
    githubLinkConfigured("iterate-installation"),
    projectEnv((path, ...events) => appended.push({ events, path })),
  );

  expect(appended).toMatchObject([
    {
      path: "/integrations/github/iterate-installation",
      events: [
        {
          idempotencyKey: "review-bot/subscription:v1",
          payload: {
            delivery: {
              mode: "wake",
              expression: [
                "workers",
                [
                  "get",
                  {
                    className: "ReviewBotApp",
                    durableWorkerKey: "app-review-bot:iterate-installation",
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
        entryPoint: "github-ai-linter-worker.ts",
        files: {
          include: ["package.json"],
          repoPath: "/repos/config",
          type: "repo",
        },
      },
    },
  });
  const entrypoint = ref.source.createWorker.virtualModules["github-ai-linter-worker.ts"];
  expect(entrypoint).toContain('"policyVersion":"2"');
  expect(entrypoint).toContain('"glob":"rules/**/*.md"');
  expect(entrypoint).toContain('"repoPath":"/repos/iterate"');
});

test("the project worker dispatches each event to its declared apps", async () => {
  const received: StreamEvent[] = [];
  const event = githubLinkConfigured("iterate-installation");

  await dispatchProjectApps(
    [
      {
        processEvent: async (event: StreamEvent) => {
          received.push(event);
        },
      },
    ],
    event,
    projectEnv(() => {}),
  );

  expect(received).toEqual([event]);
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
