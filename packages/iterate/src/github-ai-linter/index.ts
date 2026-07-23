import type { ItxBinding, StreamEvent, StreamEventInput } from "../sdk.ts";
import type { GithubAiLinterRuleSource } from "./rules.ts";

export type GithubAiLinterConfig = {
  policyVersion: string;
  rules: GithubAiLinterRuleSource;
};

const reviewBotSubscriptionConfigVersion = 3;
const configuredWorkerEntrypoint =
  "node_modules/iterate/dist/github-ai-linter/configured-worker.mjs";

export const GithubAiLinter = {
  create(config: GithubAiLinterConfig) {
    return {
      async processEvent(event: StreamEvent, env: { ITX: ItxBinding }) {
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
    durableWorkerKey: `app-review-bot-${connection}`,
    source: {
      createWorker: {
        entryPoint: configuredWorkerEntrypoint,
        files: {
          type: "repo",
          repoPath: "/repos/config",
          include: ["package.json"],
        },
        minify: true,
        virtualModules: {
          "iterate:github-ai-linter-config": `export default ${JSON.stringify(config)};`,
        },
      },
    },
  } as const;
}
