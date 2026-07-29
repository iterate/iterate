import type {
  ItxBinding,
  StatefulDynamicWorkerRef,
  StreamEvent,
  StreamEventInput,
} from "../../sdk.ts";
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
          .append(await reviewBotSubscriptionEvent(event, connection, config));
      },
    };
  },
};

async function reviewBotSubscriptionEvent(
  sourceEvent: StreamEvent,
  connection: string,
  config: GithubAiLinterConfig,
): Promise<StreamEventInput> {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: "app-review-bot#review-bot",
      receiver: {
        action: "processor-wake",
        expression: [
          "workers",
          ["get", await reviewBotAppRef(connection, config)],
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
  };
}

async function reviewBotAppRef(
  connection: string,
  config: GithubAiLinterConfig,
): Promise<StatefulDynamicWorkerRef> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(connection));
  const durableConnection = [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    type: "stateful",
    path: "/",
    className: "ReviewBotApp",
    // Fence the retired offset-zero processor's progress. A truncated SHA-256
    // keeps arbitrary connection slugs within the platform's 63-character
    // durable-key limit while retaining a collision-resistant identity.
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
  };
}
