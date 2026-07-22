import type { ItxBinding, StreamEventInput } from "../sdk.ts";
import type { IterateProjectApp } from "../project-apps.ts";
import type { GithubAiLinterRuleSource } from "./rules.ts";

export type GithubAiLinterConfig = {
  policyVersion: string;
  rules: GithubAiLinterRuleSource;
};

export type GithubAiLinterProjectApp = IterateProjectApp<{ ITX: ItxBinding }>;

const reviewBotSubscriptionConfigVersion = 1;

export const GithubAiLinter = {
  create(config: GithubAiLinterConfig): GithubAiLinterProjectApp {
    return {
      async processEvent(event, env) {
        if (event.type !== "events.iterate.com/repo/github-link-configured") return;
        const connection = event.payload?.connection;
        if (typeof connection !== "string" || connection.length === 0) return;
        using itx = await env.ITX.get();
        await itx.streams
          .get(`/integrations/github/${connection}`)
          .append(...reviewBotSubscriptionEvents(connection, config));
      },
    };
  },
};

function reviewBotSubscriptionEvents(
  connection: string,
  config: GithubAiLinterConfig,
): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "app-review-bot#review-bot",
        delivery: {
          mode: "wake",
          expression: [
            "workers",
            ["get", reviewBotAppRef(connection, config)],
            "processor",
            "wakeStreamSubscriber",
          ],
          processorSlug: "review-bot",
        },
      },
      idempotencyKey: `review-bot/subscription:v${reviewBotSubscriptionConfigVersion}`,
    },
  ];
}

function reviewBotAppRef(connection: string, config: GithubAiLinterConfig) {
  return {
    type: "stateful",
    path: "/",
    className: "ReviewBotApp",
    durableWorkerKey: `app-review-bot:${connection}`,
    source: {
      createWorker: {
        entryPoint: "github-ai-linter-worker.ts",
        files: {
          type: "repo",
          repoPath: "/repos/config",
          include: ["package.json"],
        },
        minify: true,
        virtualModules: {
          "github-ai-linter-worker.ts": [
            'import { createGithubAiLinterWorker } from "iterate/github-ai-linter/worker";',
            `export const ReviewBotApp = createGithubAiLinterWorker(${JSON.stringify(config)});`,
          ].join("\n"),
        },
      },
    },
  } as const;
}
