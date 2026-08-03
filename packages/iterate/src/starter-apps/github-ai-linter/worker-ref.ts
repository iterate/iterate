import type { StatefulDynamicWorkerRef, StreamEvent, StreamEventInput } from "../../sdk.ts";
import { githubAiLinterEventTypes } from "./contract.ts";
import type { GithubAiLinterRuleSource } from "./rules.ts";

export type GithubAiLinterConfig = {
  /**
   * Operators bump this when rule selection or policy meaning changes. It is
   * part of analysis identity, so an unchanged pull-request head is analysed
   * again instead of colliding with an older task.
   */
  policyVersion: string;
  rules: GithubAiLinterRuleSource;
};

const configuredWorkerEntrypoint =
  "node_modules/iterate/dist/starter-apps/github-ai-linter/configured-worker.mjs";

// Subscription names are opaque, source-local identities under the
// subscription-model redesign — the old `app-…#slug` placement-encoding
// convention is dead. Plain contract-slug names read as
// `subscriptions.get("review-bot")`.
export const REVIEW_BOT_SUBSCRIPTION_NAME = "review-bot";

const REVIEW_BOT_RELEVANT_WEBHOOK_CONDITION = [
  '(payload.delivery.name = "pull_request" and',
  '(payload.body.action = "opened" or',
  'payload.body.action = "ready_for_review" or',
  'payload.body.action = "synchronize"))',
  "or",
  '((payload.delivery.name = "issue_comment" or',
  'payload.delivery.name = "pull_request_review" or',
  'payload.delivery.name = "pull_request_review_comment") and',
  "$count(payload.associations.mentionedUsers) > 0)",
].join(" ");

/**
 * The review router only needs lifecycle deliveries and explicit mentions.
 * Filtering on the source stream keeps check/workflow webhook bursts out of
 * the hosted processor while the offset prefix preserves the restore cutoff.
 */
function reviewBotSubscriptionCondition(startAfterOffset: number) {
  return `offset > ${startAfterOffset} and (${REVIEW_BOT_RELEVANT_WEBHOOK_CONDITION})`;
}

export async function reviewBotSubscriptionEvent(
  sourceEvent: StreamEvent,
  connection: string,
  config: GithubAiLinterConfig,
  startAfterOffset: number,
): Promise<StreamEventInput> {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: REVIEW_BOT_SUBSCRIPTION_NAME,
      // A restored connection stream can contain thousands of old webhooks.
      // This cutoff gives a newly configured review bot future work only.
      // Config refreshes preserve the original cutoff in index.ts.
      filter: {
        eventTypes: ["events.iterate.com/github/webhook-received"],
        jsonataCondition: reviewBotSubscriptionCondition(startAfterOffset),
      },
      receiver: {
        action: "processor-wake",
        expression: [
          "workers",
          ["get", await reviewBotAppRef(connection, config)],
          "processor",
          "wakeStreamProcessor",
        ],
        processorSlug: "review-bot",
      },
    },
    idempotencyKey: `review-bot/subscription:${sourceEvent.path}:${sourceEvent.offset}`,
  };
}

export async function pullRequestLinterSubscriptionEvent(
  input: {
    connection: string;
    pullRequestNumber: number;
    repositoryId: number;
    // A processor host permanently adopts its first stream coordinate. The
    // path keeps two project-controlled repo aliases for the same GitHub PR
    // from accidentally dialing the same Durable Object.
    streamPath: string;
  },
  config: GithubAiLinterConfig,
): Promise<StreamEventInput> {
  return {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "github-ai-linter",
      // The linter Durable Object reduces this explicit protocol, not the
      // surrounding agent's tool calls, LLM bookkeeping, or conversation.
      // Source-side filtering makes a restart proportional to analyses rather
      // than to every durable event the generic agent has ever appended.
      filter: {
        eventTypes: Object.values(githubAiLinterEventTypes),
      },
      receiver: {
        action: "processor-wake",
        expression: [
          "workers",
          ["get", await pullRequestLinterAppRef(input, config)],
          "processor",
          "wakeStreamProcessor",
        ],
        processorSlug: "github-ai-linter",
      },
    },
    // Every route coordinate which changes the worker ref is part of the key.
    // `policyVersion` stands for the config body: policy/config changes must
    // bump it, or same-key/different-body validation exposes the omission.
    idempotencyKey: [
      "github-ai-linter/subscription",
      input.connection,
      input.repositoryId,
      input.pullRequestNumber,
      `policy:${config.policyVersion}`,
      `stream:${input.streamPath}`,
    ].join(":"),
  };
}

async function reviewBotAppRef(
  connection: string,
  config: GithubAiLinterConfig,
): Promise<StatefulDynamicWorkerRef> {
  return dynamicWorkerRef({
    className: "ReviewBotApp",
    config,
    durableWorkerKey: `github-ai-linter-review-bot-${await durableIdentity(connection)}`,
  });
}

async function pullRequestLinterAppRef(
  input: {
    connection: string;
    pullRequestNumber: number;
    repositoryId: number;
    streamPath: string;
  },
  config: GithubAiLinterConfig,
): Promise<StatefulDynamicWorkerRef> {
  const identity = [
    input.connection,
    String(input.repositoryId),
    String(input.pullRequestNumber),
    input.streamPath,
  ].join("\0");
  return dynamicWorkerRef({
    className: "GithubAiLinterApp",
    config,
    durableWorkerKey: `app-gh-linter-${await durableIdentity(identity)}`,
  });
}

function dynamicWorkerRef(input: {
  className: string;
  config: GithubAiLinterConfig;
  durableWorkerKey: string;
}): StatefulDynamicWorkerRef {
  return {
    type: "stateful",
    path: "/",
    className: input.className,
    durableWorkerKey: input.durableWorkerKey,
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
          "iterate:github-ai-linter-config": `export default ${JSON.stringify(input.config)};`,
        },
      },
    },
  };
}

/**
 * Dynamic-worker durable keys have a 63-character ceiling and connection
 * slugs are user-controlled. A truncated SHA-256 preserves stable identity
 * without leaking or squeezing arbitrary coordinates into that limit.
 */
async function durableIdentity(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
