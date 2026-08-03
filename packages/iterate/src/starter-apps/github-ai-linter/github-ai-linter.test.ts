import { expect, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "../../sdk.ts";
import { GithubAiLinter } from "./index.ts";
import { mightWakePullRequestAgent } from "./review-bot.ts";

test("a linked connection gets a hosted review processor", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create(
    projectEnv(
      (path, ...events) => appended.push({ events, path }),
      {},
      { "/integrations/github/iterate-installation": { maxOffset: 8_123 } },
    ),
    {
      policyVersion: "2",
      rules: {
        paths: [
          "rules/structure/no-small-single-use-helper.md",
          "rules/typescript/no-inferable-type-annotation.md",
        ],
        repoPath: "/repos/config",
      },
    },
  );

  await app.processEvent({
    ...githubLinkConfigured("ignored", 1),
    type: "events.iterate.com/project/heartbeat",
  });
  await app.processEvent({ ...githubLinkConfigured("ignored", 2), payload: { connection: "" } });
  await app.processEvent(githubLinkConfigured("iterate-installation", 3));

  expect(appended).toHaveLength(1);
  expect(appended[0]).toMatchObject({
    path: "/integrations/github/iterate-installation",
    events: [
      {
        idempotencyKey: "review-bot/subscription:/:3",
        payload: {
          receiver: {
            action: "processor-wake",
            expression: [
              "workers",
              [
                "get",
                {
                  className: "ReviewBotApp",
                  durableWorkerKey: expect.stringMatching(
                    /^github-ai-linter-review-bot-[0-9a-f]{32}$/,
                  ),
                  path: "/",
                  type: "stateful",
                },
              ],
              "processor",
              "wakeStreamProcessor",
            ],
            processorSlug: "review-bot",
          },
          filter: {
            eventTypes: ["events.iterate.com/github/webhook-received"],
            jsonataCondition: expect.stringMatching(/^offset > 8123 and /),
          },
          name: "app-review-bot#review-bot",
        },
        type: "events.iterate.com/stream/subscription-configured",
      },
    ],
  });

  const subscription = appended[0]!.events[0]!;
  const receiver = subscription.payload?.receiver;
  if (
    typeof receiver !== "object" ||
    receiver === null ||
    !("expression" in receiver) ||
    !Array.isArray(receiver.expression)
  ) {
    throw new Error("test subscription has no processor expression");
  }
  const getStep = receiver.expression[1];
  if (!Array.isArray(getStep) || typeof getStep[1] !== "object" || getStep[1] === null) {
    throw new Error("test subscription has no worker ref");
  }
  const ref = getStep[1] as {
    source?: {
      createWorker?: {
        entryPoint?: string;
        files?: unknown;
        virtualModules?: Record<string, string>;
      };
    };
  };
  expect(ref.source?.createWorker).toMatchObject({
    entryPoint: "node_modules/iterate/dist/starter-apps/github-ai-linter/configured-worker.mjs",
    files: {
      include: ["package.json"],
      repoPath: "/repos/config",
      type: "repo",
    },
  });
  expect(ref.source?.createWorker?.virtualModules?.["iterate:github-ai-linter-config"]).toContain(
    '"paths":["rules/structure/no-small-single-use-helper.md",',
  );
});

test("a config worker update refreshes every linked connection processor", async () => {
  const appended: Array<{ events: StreamEventInput[]; path: string }> = [];
  const app = GithubAiLinter.create(
    projectEnv(
      (path, ...events) => appended.push({ events, path }),
      {
        "/repos/config": "iterate-installation",
        "/repos/product": "iterate-installation",
      },
      {
        "/integrations/github/iterate-installation": {
          existingReviewBotCutoff: 7_500,
          maxOffset: 9_000,
        },
      },
    ),
    {
      policyVersion: "3",
      rules: {
        paths: ["rules/structure/no-small-single-use-helper.md"],
        repoPath: "/repos/config",
      },
    },
  );

  await app.processEvent({
    ...githubLinkConfigured("ignored", 4),
    type: "events.iterate.com/project/worker-updated",
  });

  expect(appended).toHaveLength(1);
  expect(appended[0]).toMatchObject({
    path: "/integrations/github/iterate-installation",
    events: [
      {
        idempotencyKey: "review-bot/subscription:/:4",
        payload: {
          receiver: {
            action: "processor-wake",
            processorSlug: "review-bot",
          },
          filter: {
            eventTypes: ["events.iterate.com/github/webhook-received"],
            jsonataCondition: expect.stringMatching(/^offset > 7500 and /),
          },
          name: "app-review-bot#review-bot",
        },
      },
    ],
  });
  expect(JSON.stringify(appended[0])).toContain('\\"policyVersion\\":\\"3\\"');
});

test("the processor prefilter admits only review lifecycle events and explicit mentions", () => {
  expect(
    mightWakePullRequestAgent(
      webhookEvent({ action: "completed", name: "check_run", mentionedUsers: [] }),
    ),
  ).toBe(false);
  expect(
    mightWakePullRequestAgent(
      webhookEvent({ action: "opened", name: "pull_request", mentionedUsers: [] }),
    ),
  ).toBe(true);
  expect(
    mightWakePullRequestAgent(
      webhookEvent({ action: "created", name: "issue_comment", mentionedUsers: ["iterate"] }),
    ),
  ).toBe(true);
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

function webhookEvent(input: {
  action: string;
  mentionedUsers: string[];
  name: string;
}): StreamEvent {
  return {
    createdAt: "2026-07-29T06:00:00.000Z",
    offset: 1,
    path: "/integrations/github/iterate-installation",
    payload: {
      associations: { mentionedUsers: input.mentionedUsers },
      body: { action: input.action },
      delivery: { name: input.name },
    },
    type: "events.iterate.com/github/webhook-received",
  };
}

function projectEnv(
  append: (path: string, ...events: StreamEventInput[]) => void,
  repoConnections: Record<string, string> = {},
  connectionStreams: Record<string, { existingReviewBotCutoff?: number; maxOffset: number }> = {},
) {
  return {
    ITX: {
      get: async () => ({
        [Symbol.dispose]() {},
        repos: {
          get: (path: string) => ({
            processor: {
              snapshot: async () => ({
                state: {
                  github: {
                    connection: repoConnections[path],
                  },
                },
              }),
            },
          }),
          list: async () => Object.keys(repoConnections).map((path) => ({ path })),
        },
        streams: {
          get: (path: string) => ({
            append: async (...events: StreamEventInput[]) => append(path, ...events),
            runtimeState: async () => {
              const fixture = connectionStreams[path];
              const existingReviewBotCutoff = fixture?.existingReviewBotCutoff;
              return {
                coreProcessorState: {
                  maxOffset: fixture?.maxOffset ?? 0,
                  subscriptions: {
                    outbound: {
                      byName:
                        existingReviewBotCutoff === undefined
                          ? {}
                          : {
                              "app-review-bot#review-bot": {
                                configuration: {
                                  filter: {
                                    jsonataCondition: `offset > ${existingReviewBotCutoff}`,
                                  },
                                },
                              },
                            },
                    },
                  },
                },
              };
            },
          }),
        },
      }),
    },
  } as never;
}
