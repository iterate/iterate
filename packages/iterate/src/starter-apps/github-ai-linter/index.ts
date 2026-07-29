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
          event.type !== "events.iterate.com/repo/github-link-configured" &&
          event.type !== "events.iterate.com/repo/github-unlinked"
        ) {
          return;
        }
        if (
          event.type === "events.iterate.com/github/webhook-received" &&
          event.source?.copiedFrom !== undefined
        ) {
          return;
        }
        if (event.type === "events.iterate.com/repo/github-unlinked") {
          linkedRepos = undefined;
          return;
        }
        if (
          event.type === "events.iterate.com/github/webhook-received" &&
          !mightWakePullRequestAgent(event)
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

function mightWakePullRequestAgent(event: StreamEvent): boolean {
  // The platform created this envelope after signature verification. This
  // deliberately stays a loose prefilter; the handler below performs the
  // complete authorization and payload validation after an ITX session opens.
  const webhook = event.payload as
    | {
        associations?: { mentionedUsers?: unknown[] };
        body?: { action?: unknown };
        delivery?: { name?: unknown };
      }
    | undefined;
  const name = webhook?.delivery?.name;
  const action = webhook?.body?.action;
  return (
    (name === "pull_request" &&
      (action === "opened" || action === "ready_for_review" || action === "synchronize")) ||
    ((name === "issue_comment" ||
      name === "pull_request_review" ||
      name === "pull_request_review_comment") &&
      (webhook?.associations?.mentionedUsers?.length ?? 0) > 0)
  );
}

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
