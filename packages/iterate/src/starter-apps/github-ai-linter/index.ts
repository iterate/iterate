import type { ItxBinding, Project, StreamEvent } from "../../sdk.ts";
import {
  handleGithubPullRequestWebhook,
  loadLinkedGithubRepos,
  type LinkedGithubRepo,
} from "./review-bot.ts";
import { loadGithubAiLinterRules, type GithubAiLinterRuleSource } from "./rules.ts";

export type GithubAiLinterConfig = {
  policyVersion: string;
  rules: GithubAiLinterRuleSource;
};

export const GithubAiLinter = {
  create(env: { ITX: ItxBinding }, config: GithubAiLinterConfig) {
    let linkedRepos: LinkedGithubRepo[] | undefined;
    return {
      async processEvent(event: StreamEvent) {
        if (
          event.type !== "events.iterate.com/github/webhook-received" &&
          event.type !== "events.iterate.com/repo/github-link-configured"
        ) {
          return;
        }
        if (
          event.type === "events.iterate.com/github/webhook-received" &&
          event.source?.copiedFrom !== undefined
        ) {
          return;
        }
        using itx = await env.ITX.get();
        if (event.type === "events.iterate.com/repo/github-link-configured") {
          linkedRepos = undefined;
          const connection = event.payload?.connection;
          if (typeof connection === "string" && connection.length > 0) {
            await retireHostedReviewBot(itx, connection);
          }
          return;
        }
        await handleGithubPullRequestWebhook(itx, event, {
          loadLinkedRepos: async () => (linkedRepos ??= await loadLinkedGithubRepos(itx)),
          loadRules: () => loadGithubAiLinterRules(itx, config.rules),
          policyVersion: config.policyVersion,
        });
      },
    };
  },
};

async function retireHostedReviewBot(itx: Project, connection: string): Promise<void> {
  const stream = itx.streams.get(`/integrations/github/${connection}`);
  const state = await stream.runtimeState();
  if (
    state.coreProcessorState.subscriptions.outbound.byKey["app-review-bot#review-bot"] === undefined
  ) {
    return;
  }
  await stream.append({
    type: "events.iterate.com/stream/subscription-removed",
    idempotencyKey: "github-ai-linter:retire-hosted-review-bot:v1",
    payload: {
      subscriptionKey: "app-review-bot#review-bot",
      reason: "requested",
    },
  });
}
