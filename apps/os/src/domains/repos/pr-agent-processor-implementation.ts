// Implements the "github-pr-agent" processor on itx, shaped after the
// email-agent processor. Emitted event types, payloads, and idempotency keys
// are stable wire formats.

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { readNumber, readRecord, readString } from "../integrations/utils.ts";
import {
  PrAgentProcessorContract,
  type PrAgentProcessorState,
} from "./pr-agent-processor-contract.ts";

/** How the agent is addressed in PR text: `@iterate` preceded by a non-word
 * boundary, so `support@iterate.com` in a pasted log never wakes the agent
 * while slug variants like `@iterate-preview-1` still do. GitHub gives Apps
 * no native mention routing, so this stays a text match. */
const AGENT_MENTION_PATTERN = /(^|[^\w@])@iterate/i;

/** Webhook actions whose mention may trigger a turn: a NEW comment, a
 * submitted review, or the PR opening (its description is the first place
 * people write "@iterate please …"). Deliberately excludes `edited` and
 * `deleted` — GitHub sends the full comment body on both, and deleting your
 * mention must not wake the agent to answer a request that no longer exists. */
const TRIGGERING_ACTIONS = new Set(["created", "submitted", "opened"]);

export class PrAgentProcessor extends StreamProcessor<PrAgentProcessorContract> {
  readonly contract = PrAgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<PrAgentProcessorContract>["reduce"]>[0]): PrAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/github-pr/route-configured":
        // Last write wins: a relink of the repo to a different GitHub
        // repository or connection emits a fresh route event (new key) that
        // repoints this agent's coordinates.
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
        // static, the PR coordinates are not. Keyed by the coordinates so a
        // relink's new route event produces a fresh, corrected input instead
        // of deduping into the stale one. Never wakes the LLM by itself.
        const routeKey = `${event.payload.connection}:${event.payload.owner}/${event.payload.repo}#${event.payload.number}`;
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey(`route-context:${routeKey}`),
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
        const action = readString(body.action) ?? "";
        const mentioned = AGENT_MENTION_PATTERN.test(mentionTextFromWebhookBody(body, action));
        const triggers = mentioned && !senderIsBot && TRIGGERING_ACTIONS.has(action);

        // Durable obligation: the input is the webhook's only path to the
        // LLM, so a failed append must hold the checkpoint and replay.
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey("webhook-to-agent-input", event),
            payload: {
              content: pullRequestWebhookAgentInput(event.payload, body, state),
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

/** The text a mention can live in, per event kind: comment bodies, review
 * bodies, and — only when the PR is being opened — the PR description. */
function mentionTextFromWebhookBody(body: Record<string, unknown>, action: string): string {
  const comment = readRecord(body.comment);
  const review = readRecord(body.review);
  const pullRequestBody =
    action === "opened" ? readString(readRecord(body.pull_request)?.body) : undefined;
  return readString(comment?.body) ?? readString(review?.body) ?? pullRequestBody ?? "";
}

/**
 * The model-visible transcription of one PR webhook: curated rather than the
 * raw payload (GitHub bodies run to tens of KB of hydrated objects), in the
 * same `<type>` + fenced-yaml envelope the Slack and email transcribers use.
 * The repository's full_name rides along so a repoint of the repo's GitHub
 * link is visible to the model, not only in route facts.
 */
function pullRequestWebhookAgentInput(
  payload: unknown,
  body: Record<string, unknown>,
  state: PrAgentProcessorState,
): string {
  const pullRequest = readRecord(body.pull_request);
  const issue = readRecord(body.issue);
  const comment = readRecord(body.comment);
  const review = readRecord(body.review);
  const sender = readRecord(body.sender);

  // The ingress door captures the x-github-event header as headers.githubEvent;
  // fall back to the body shape for events captured by other doors.
  const shapeKind =
    comment !== null
      ? "comment"
      : review !== null
        ? "review"
        : pullRequest !== null
          ? "pull_request"
          : "webhook";
  const headers = readRecord((payload as { headers?: unknown } | null)?.headers);
  const kind = readString(headers?.githubEvent) ?? shapeKind;

  const transcript = {
    event: kind,
    action: readString(body.action),
    repository: readString(readRecord(body.repository)?.full_name),
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
  };
  return [
    "`events.iterate.com/github/webhook-received` event received",
    "",
    "```yaml",
    stringifyYaml(JSON.parse(JSON.stringify(transcript))).trimEnd(),
    "```",
  ].join("\n");
}
