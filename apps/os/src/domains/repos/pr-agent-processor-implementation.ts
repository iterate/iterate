// Implements the "github-pr-agent" processor on itx, shaped after the
// email-agent processor. Emitted event types, payloads, and idempotency keys
// are stable wire formats.

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { readRecord, readString } from "../integrations/utils.ts";
import {
  PrAgentProcessorContract,
  type PrAgentProcessorState,
} from "./pr-agent-processor-contract.ts";

/** How the agent is addressed in PR comments. GitHub gives Apps no native
 * mention routing, so this is a plain substring match on comment bodies; it
 * deliberately also matches slug variants like `@iterate-preview-1`. */
const AGENT_MENTION = "@iterate";

export class PrAgentProcessor extends StreamProcessor<PrAgentProcessorContract> {
  readonly contract = PrAgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<PrAgentProcessorContract>["reduce"]>[0]): PrAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/github-pr/route-configured":
        return { ...state, ...event.payload };
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    state,
  }: Parameters<StreamProcessor<PrAgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/github-pr/route-configured": {
        // The route context as a model-visible input: the system prompt is
        // static, the PR coordinates are not. Never wakes the LLM by itself.
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `github-pr-agent:route-context:${event.payload.streamPath}`,
            payload: {
              content: [
                `You are the agent for pull request #${event.payload.number} of ${event.payload.owner}/${event.payload.repo}.`,
                `- Reply on the PR with await itx.integrations.github[${JSON.stringify(event.payload.connection)}].rest.issues.createComment({ owner: ${JSON.stringify(event.payload.owner)}, repo: ${JSON.stringify(event.payload.repo)}, issue_number: ${event.payload.number}, body }).`,
                `- The linked project repo is itx.repos.get(${JSON.stringify(event.payload.repoPath)}) (readFile/listFiles); the same Octokit reaches PR files and diffs (rest.pulls.get, rest.pulls.listFiles).`,
              ].join("\n"),
              llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
            },
          });
        });
        return;
      }
      case "events.iterate.com/github/webhook-received": {
        const body = readRecord((event.payload as { body?: unknown }).body);
        if (body === null) return;

        // The agent's own comments come back as webhooks (the app's bot
        // identity); recording them silently is fine, triggering on them is a
        // self-loop. Bot senders never trigger, mirroring "bot messages never
        // trigger agents" from Slack and the email automated-mail guard.
        const sender = readRecord(body.sender);
        const senderIsBot = sender !== null && readString(sender.type) === "Bot";
        const mentioned = commentTextFromWebhookBody(body).toLowerCase().includes(AGENT_MENTION);
        const triggers = mentioned && !senderIsBot;

        // Durable obligation: the input is the webhook's only path to the
        // LLM, so a failed append must hold the checkpoint and replay.
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `github-pr-agent:webhook-to-agent-input:${event.offset}`,
            payload: {
              content: pullRequestWebhookAgentInput(body, state),
              ...(triggers
                ? {}
                : { llmRequestPolicy: { behaviour: "dont-trigger-request" as const } }),
            },
          });
        });
        return;
      }
      default:
        return;
    }
  }
}

/** The comment-ish text of a PR webhook, wherever this event kind carries it. */
function commentTextFromWebhookBody(body: Record<string, unknown>): string {
  const comment = readRecord(body.comment);
  const review = readRecord(body.review);
  return readString(comment?.body) ?? readString(review?.body) ?? "";
}

/**
 * The model-visible transcription of one PR webhook. Curated rather than the
 * raw payload (GitHub bodies run to tens of KB of hydrated objects): the
 * event kind, who did what, and the human-written text.
 */
function pullRequestWebhookAgentInput(
  body: Record<string, unknown>,
  state: PrAgentProcessorState,
): string {
  const pullRequest = readRecord(body.pull_request);
  const issue = readRecord(body.issue);
  const comment = readRecord(body.comment);
  const review = readRecord(body.review);
  const sender = readRecord(body.sender);

  const kind =
    comment !== null
      ? "comment"
      : review !== null
        ? "review"
        : pullRequest !== null
          ? "pull_request"
          : "webhook";

  const transcript = {
    github_pull_request_event: {
      kind,
      action: readString(body.action),
      pullRequest: {
        number: state.number ?? readNumber(pullRequest?.number) ?? readNumber(issue?.number),
        title: readString(pullRequest?.title) ?? readString(issue?.title),
        state: readString(pullRequest?.state),
        draft: typeof pullRequest?.draft === "boolean" ? pullRequest.draft : undefined,
        headRef: readString(readRecord(pullRequest?.head)?.ref),
        baseRef: readString(readRecord(pullRequest?.base)?.ref),
        body: readString(pullRequest?.body),
      },
      sender: {
        login: readString(sender?.login),
        type: readString(sender?.type),
      },
      ...(comment === null
        ? {}
        : { comment: { body: readString(comment.body), url: readString(comment.html_url) } }),
      ...(review === null
        ? {}
        : { review: { state: readString(review.state), body: readString(review.body) } }),
    },
  };
  return stringifyYaml(JSON.parse(JSON.stringify(transcript)));
}

/** `value` as a number when it is one; undefined otherwise (webhook bodies are untrusted). */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
