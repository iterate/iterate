import type { ItxBinding, StreamEvent, StreamEventInput } from "../../sdk.ts";
import type { GithubAiLinterRuleSource } from "./rules.ts";

export type GithubAiLinterConfig = {
  policyVersion: string;
  rules: GithubAiLinterRuleSource;
};

const reviewBotSubscriptionConfigVersion = 5;
const reviewBotDurableWorkerVersion = 2;
const configuredWorkerEntrypoint =
  "node_modules/iterate/dist/starter-apps/github-ai-linter/configured-worker.mjs";

export const GithubAiLinter = {
  create(env: { ITX: ItxBinding }, config: GithubAiLinterConfig) {
    return {
      async processEvent(event: StreamEvent) {
        if (event.type !== "events.iterate.com/repo/github-link-configured") return;
        const connection = event.payload?.connection;
        if (typeof connection !== "string" || connection.length === 0) return;
        using itx = await env.ITX.get();
        await itx.streams
          .get(`/integrations/github/${connection}`)
          .append(...reviewBotSubscriptionEvents(event, connection, config));
      },
    };
  },
};

function reviewBotSubscriptionEvents(
  sourceEvent: StreamEvent,
  connection: string,
  config: GithubAiLinterConfig,
): StreamEventInput[] {
  return [
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        subscriptionKey: "app-review-bot#review-bot",
        receiver: {
          action: "processor-wake",
          expression: [
            "workers",
            ["get", reviewBotAppRef(connection, config)],
            "processor",
            "wakeStreamProcessor",
          ],
          processorSlug: "review-bot",
          // A restored connection stream can contain months of webhooks. The
          // processor starts after this committed configuration event, while
          // stream delivery still includes anything appended after it.
          delivery: { start: "now" },
        },
      },
      idempotencyKey: `review-bot/subscription:v${reviewBotSubscriptionConfigVersion}:${sourceEvent.path}:${sourceEvent.offset}`,
    },
  ];
}

function reviewBotAppRef(connection: string, config: GithubAiLinterConfig) {
  const durableConnection = connection.replaceAll("-", "--").replaceAll("_", "-u");
  return {
    type: "stateful",
    path: "/",
    className: "ReviewBotApp",
    // Fence the retired offset-zero processor's progress. Connection slugs
    // admit `_`, but durable keys do not; escaping both separator characters
    // keeps the identity readable and collision-free.
    durableWorkerKey: `app-review-bot-${durableConnection}-v${reviewBotDurableWorkerVersion}`,
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
