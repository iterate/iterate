// GitHub-specific behavior for one pull-request agent stream. Raw webhooks
// stay as durable, point-readable facts; this processor folds a bounded PR
// projection and renders that projection only when policy asks for an LLM
// turn. Emitted event types, payloads, and idempotency keys are wire formats.

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  githubAccessTokenPlaceholder,
  readNumber,
  readRecord,
  readString,
} from "../integrations/utils.ts";
import {
  GithubAgentProcessorContract,
  type GithubAgentProcessorState,
} from "./github-agent-processor-contract.ts";

/** GitHub Apps do not get native mention routing. Match the production App
 * and preview slug variants, but never an email address such as
 * support@iterate.com. */
const AGENT_MENTION_PATTERN = /(^|[^\w@])@iterate(?:-[a-z0-9-]+)?\b/i;

/** Persistent per-PR review controls use GitHub's own permissioned labels. A
 * conversational `review now` remains a one-off request, not another state
 * machine layered over GitHub. */
const REVIEW_NOW_PATTERN =
  /(^|[^\w@])@iterate(?:-[a-z0-9-]+)?\s+(?:automatic\s+)?reviews?\s+now\b/i;
const REVIEW_LABEL = "iterate:review";
const SKIP_REVIEW_LABEL = "iterate:skip-review";

/** A mention in a NEW comment/review/description can queue work. Edits and
 * deletes carry old text too, so treating them as requests resurrects stale
 * instructions. */
const MENTION_TRIGGERING_ACTIONS = new Set(["created", "opened", "submitted"]);
const REVIEW_CANDIDATE_ACTIONS = new Set(["opened", "ready_for_review", "synchronize"]);

const MAX_ACTIVITY_SUMMARY_LENGTH = 1_200;
const MAX_PULL_REQUEST_BODY_LENGTH = 4_000;
const RECENT_ACTIVITY_LIMIT = 12;

export class GithubAgentProcessor extends StreamProcessor<GithubAgentProcessorContract> {
  readonly contract = GithubAgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<
    StreamProcessor<GithubAgentProcessorContract>["reduce"]
  >[0]): GithubAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/github-agent/configure":
        // One complete fact, last write wins. It owns every project policy
        // option; per-PR label controls remain separate folded facts.
        return { ...state, configuration: event.payload };
      case "events.iterate.com/github-agent/route-configured":
        return { ...state, ...event.payload };
      case "events.iterate.com/github/webhook-received":
        return reduceGithubWebhook({ event, state });
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    state,
  }: Parameters<StreamProcessor<GithubAgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/github-agent/route-configured": {
        // Small stable boot fact, never a turn trigger. Every actual trigger
        // repeats current coordinates so a relink cannot leave the model
        // relying on stale history.
        const routeKey = `${event.payload.connection}:${event.payload.owner}/${event.payload.repo}#${event.payload.number}`;
        const octokit = `itx.integrations.github[${JSON.stringify(event.payload.connection)}].octokit`;
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: this.idempotencyKey(`route-context:${routeKey}`),
            payload: {
              content: [
                `You are the GitHub agent for pull request #${event.payload.number} of ${event.payload.owner}/${event.payload.repo}.`,
                `- ${octokit} is the all-in-one Octokit from the octokit package, with Iterate supplying its installation auth and transport. Use its normal .rest.* methods for routine endpoints or .graphql(query, variables) when GraphQL is a better fit; see https://github.com/octokit/octokit.js/. For example: await ${octokit}.rest.pulls.get({ owner: ${JSON.stringify(event.payload.owner)}, repo: ${JSON.stringify(event.payload.repo)}, pull_number: ${event.payload.number} }).`,
                `- Reply with ${octokit}.rest.issues.createComment(...), or post a review with ${octokit}.rest.pulls.createReview(...).`,
                `- For code changes, clone the live PR head into a project sandbox and edit/test/commit/push there. Do not use itx.repo or itx.workspace: those write the linked project's default branch.`,
                `- Raw GitHub deliveries are durable events on ${JSON.stringify(event.payload.streamPath)}; a turn input gives exact offsets and the getEvent(...) call when its bounded rendering omits something.`,
              ].join("\n"),
              llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
            },
          });
        });
        return;
      }

      case "events.iterate.com/github-agent/configure": {
        // Birth is racy by design: the first webhook creates the stream, while
        // the project worker appends policy afterward. If a reviewable head is
        // already folded when enabled policy arrives, request it now. The
        // head-keyed append dedupes against the opposite ordering.
        const candidate = state.reviewCandidate;
        if (candidate === null || !shouldAutomaticallyReview(state, candidate)) return;
        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agents/message-received",
            idempotencyKey: this.idempotencyKey(`automatic-review:${candidate.headSha}`),
            payload: {
              content: githubAgentTurnInput({
                automaticReview: true,
                sourceOffset: candidate.offset,
                state,
              }),
              from: { kind: "github" as const },
              llmRequestPolicy: { behaviour: "interrupt-current-request" as const },
            },
          });
        });
        return;
      }

      case "events.iterate.com/github/webhook-received": {
        const body = readRecord((event.payload as { body?: unknown }).body);
        if (body === null) return;

        const sender = readRecord(body.sender);
        const senderIsBot = readString(sender?.type) === "Bot";
        const action = readString(body.action) ?? "";
        const mentionText = mentionTextFromWebhookBody(body, action);
        const mentioned =
          !senderIsBot &&
          MENTION_TRIGGERING_ACTIONS.has(action) &&
          AGENT_MENTION_PATTERN.test(mentionText);
        const reviewNow = mentioned && REVIEW_NOW_PATTERN.test(mentionText);

        const candidate =
          state.reviewCandidate?.offset === event.offset ? state.reviewCandidate : null;
        const automaticReview =
          reviewNow || (candidate !== null && shouldAutomaticallyReview(state, candidate));

        if (!mentioned && !automaticReview) return;
        const behaviour = automaticReview
          ? ("interrupt-current-request" as const)
          : ("after-current-request" as const);

        const headSha = state.reviewCandidate?.headSha ?? state.pullRequest?.headSha;
        // An automatic review of one head is one durable request whether it
        // was noticed from the webhook or the later configuration fact. A
        // `review now` is explicitly repeatable, so it keys on the comment
        // delivery instead.
        const idempotencyKey =
          automaticReview && !reviewNow && headSha !== undefined
            ? this.idempotencyKey(`automatic-review:${headSha}`)
            : this.idempotencyKey("webhook-turn", event);
        const senderLogin = readString(sender?.login);
        const senderType = readString(sender?.type);

        blockProcessorWhile(async () => {
          await append({
            type: "events.iterate.com/agents/message-received",
            idempotencyKey,
            payload: {
              content: githubAgentTurnInput({
                automaticReview,
                mentioned: mentioned && !reviewNow,
                sourceOffset: event.offset,
                state,
              }),
              from: {
                kind: "github" as const,
                ...(senderLogin === undefined ? {} : { login: senderLogin }),
                ...(senderType === undefined ? {} : { senderType }),
              },
              llmRequestPolicy: { behaviour },
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

function reduceGithubWebhook(input: {
  event: {
    createdAt: string;
    offset: number;
    payload: Record<string, unknown>;
  };
  state: GithubAgentProcessorState;
}): GithubAgentProcessorState {
  const body = readRecord(input.event.payload.body);
  if (body === null) return input.state;

  const pullRequest = readRecord(body.pull_request);
  const issue = readRecord(body.issue);
  const currentPullRequest = input.state.pullRequest;
  const labels =
    pullRequest === null
      ? (currentPullRequest?.labels ?? [])
      : labelsFromPullRequest(pullRequest, currentPullRequest?.labels ?? [], body);
  const nextPullRequest =
    pullRequest === null
      ? currentPullRequest
      : {
          author: readString(readRecord(pullRequest.user)?.login) ?? currentPullRequest?.author,
          baseRef: readString(readRecord(pullRequest.base)?.ref) ?? currentPullRequest?.baseRef,
          baseSha: readString(readRecord(pullRequest.base)?.sha) ?? currentPullRequest?.baseSha,
          body:
            truncate(readString(pullRequest.body), MAX_PULL_REQUEST_BODY_LENGTH) ??
            currentPullRequest?.body,
          draft:
            typeof pullRequest.draft === "boolean" ? pullRequest.draft : currentPullRequest?.draft,
          headRef: readString(readRecord(pullRequest.head)?.ref) ?? currentPullRequest?.headRef,
          headRepo:
            readString(readRecord(readRecord(pullRequest.head)?.repo)?.name) ??
            currentPullRequest?.headRepo,
          headRepoOwner:
            readString(readRecord(readRecord(readRecord(pullRequest.head)?.repo)?.owner)?.login) ??
            currentPullRequest?.headRepoOwner,
          headSha: readString(readRecord(pullRequest.head)?.sha) ?? currentPullRequest?.headSha,
          labels,
          state: readString(pullRequest.state) ?? currentPullRequest?.state,
          title:
            readString(pullRequest.title) ?? readString(issue?.title) ?? currentPullRequest?.title,
          url: readString(pullRequest.html_url) ?? currentPullRequest?.url,
        };

  const activity = activityFromWebhook({
    body,
    createdAt: input.event.createdAt,
    offset: input.event.offset,
    payload: input.event.payload,
  });
  const recentActivity = [...input.state.recentActivity, activity].slice(-RECENT_ACTIVITY_LIMIT);
  const action = readString(body.action);
  const headSha = readString(readRecord(pullRequest?.head)?.sha);
  const reviewWasEnabled = reviewWasEnabledByWebhook(body);
  const candidateHeadSha = headSha ?? (reviewWasEnabled ? nextPullRequest?.headSha : undefined);
  const reviewCandidate =
    ((action !== undefined && REVIEW_CANDIDATE_ACTIONS.has(action)) || reviewWasEnabled) &&
    candidateHeadSha !== undefined
      ? {
          draft: nextPullRequest?.draft ?? false,
          headSha: candidateHeadSha,
          offset: input.event.offset,
        }
      : input.state.reviewCandidate;

  return {
    ...input.state,
    pullRequest: nextPullRequest,
    recentActivity,
    reviewCandidate,
  };
}

function labelsFromPullRequest(
  pullRequest: Record<string, unknown>,
  previous: string[],
  body: Record<string, unknown>,
): string[] {
  if (Array.isArray(pullRequest.labels)) {
    return pullRequest.labels
      .map((label) => readString(readRecord(label)?.name))
      .filter((name): name is string => name !== undefined);
  }
  // Defensive fallback for trimmed fixtures/forwarders. GitHub's real PR
  // webhook includes the full pull_request object and label list.
  const action = readString(body.action);
  const label = readString(readRecord(body.label)?.name);
  if (label === undefined) return previous;
  if (action === "labeled") return [...new Set([...previous, label])];
  if (action === "unlabeled") return previous.filter((name) => name !== label);
  return previous;
}

function mentionTextFromWebhookBody(body: Record<string, unknown>, action: string): string {
  const comment = readRecord(body.comment);
  const review = readRecord(body.review);
  const pullRequestBody =
    action === "opened" ? readString(readRecord(body.pull_request)?.body) : undefined;
  return readString(comment?.body) ?? readString(review?.body) ?? pullRequestBody ?? "";
}

function reviewWasEnabledByWebhook(body: Record<string, unknown>): boolean {
  const action = readString(body.action);
  const label = readString(readRecord(body.label)?.name)?.toLowerCase();
  return (
    (action === "labeled" && label === REVIEW_LABEL) ||
    (action === "unlabeled" && label === SKIP_REVIEW_LABEL)
  );
}

function effectiveAutomaticReviewEnabled(state: GithubAgentProcessorState): boolean {
  const labels = new Set(state.pullRequest?.labels.map((label) => label.toLowerCase()) ?? []);
  if (labels.has(SKIP_REVIEW_LABEL)) return false;
  if (labels.has(REVIEW_LABEL)) return true;
  return state.configuration.automaticReview.enabled;
}

function shouldAutomaticallyReview(
  state: GithubAgentProcessorState,
  candidate: NonNullable<GithubAgentProcessorState["reviewCandidate"]>,
): boolean {
  if (!effectiveAutomaticReviewEnabled(state)) return false;
  if (state.pullRequest?.state !== undefined && state.pullRequest.state !== "open") return false;
  if (state.pullRequest?.headSha !== undefined && state.pullRequest.headSha !== candidate.headSha) {
    return false;
  }
  return !(state.pullRequest?.draft ?? candidate.draft);
}

function githubAgentTurnInput(input: {
  automaticReview: boolean;
  mentioned?: boolean;
  sourceOffset: number;
  state: GithubAgentProcessorState;
}): string {
  const { state } = input;
  const streamPath = state.streamPath ?? "this agent stream";
  const octokit =
    state.connection === undefined
      ? 'itx.integrations.github["<connection>"].octokit'
      : `itx.integrations.github[${JSON.stringify(state.connection)}].octokit`;
  const githubToken =
    state.connection === undefined ? null : githubAccessTokenPlaceholder(state.connection);
  const effectiveReview = effectiveAutomaticReviewEnabled(state);
  const tasks: string[] = [];

  if (input.mentioned === true) {
    tasks.push(
      [
        "A human mentioned you. Address the request in the triggering activity. Do the necessary repository/GitHub work before replying.",
        "If the request changes code, fetch the live PR, then use a project sandbox to clone pull_request.head.repo.clone_url and check out pull_request.head.ref. Sandboxes have git, gh, and the GitHub installation's GH_TOKEN; reuse one from itx.sandboxes.list() or create one with itx.sandboxes.create(...), then use gitCheckout/exec to edit and run the repository's tests normally.",
        githubToken === null
          ? "Before cloning, identify the route's GitHub connection and bind the sandbox GH_TOKEN to that connection; do not assume a project with several installations selected the right token automatically."
          : `Before cloning, bind the sandbox to this PR's installation with await sandbox.setEnvVars({ GH_TOKEN: ${JSON.stringify(githubToken)} }), then refresh git's auth header with await sandbox.exec('git config --global http."https://github.com/".extraheader "AUTHORIZATION: Bearer $GH_TOKEN"').`,
        "Commit in the sandbox and push HEAD to the exact head ref without force. Re-fetch the PR immediately before pushing; if its head SHA moved, incorporate the newer head instead of overwriting it. Never use itx.repo, itx.workspace, the base repo, or the default branch as the PR write door.",
        "A fork may be outside this GitHub App installation. If its head repo cannot be cloned or pushed, post one concise comment explaining the permission blocker; never fall back to changing the base branch.",
      ].join("\n"),
    );
  }

  if (input.automaticReview) {
    const headSha = state.reviewCandidate?.headSha ?? state.pullRequest?.headSha;
    const reviewHead = headSha === undefined ? "reviewHead" : JSON.stringify(headSha);
    tasks.push(
      [
        headSha === undefined
          ? "Fetch the current PR first and use its current head SHA as `reviewHead`. This one-off request is not tied to an earlier head snapshot; do not abort merely because the bounded context had no head SHA."
          : `Review head ${headSha} against the project rules below. Before doing expensive work, fetch the current PR and compare its head SHA. If it is no longer this head, end without posting; the newer push has its own trigger.`,
        `Read the complete diff with ${octokit}.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { owner, repo, pull_number }) and fetch full files when patches are truncated.`,
        `Post exactly one COMMENT review with ${octokit}.rest.pulls.createReview({ owner, repo, pull_number, commit_id: ${reviewHead}, event: "COMMENT", body, comments }). Omit comments unless you have exact changed lines; otherwise put findings in the review body.`,
        `Include the hidden marker ${headSha === undefined ? "`<!-- iterate-review:${reviewHead} -->`" : `<!-- iterate-review:${headSha} -->`}. First inspect ${octokit}.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number }) and do not post if that marker already exists; tool retries must not duplicate a review.`,
        "Rules:",
        state.configuration.automaticReview.instructions,
      ].join("\n"),
    );
  }

  const route = {
    connection: state.connection,
    owner: state.owner,
    repo: state.repo,
    pullRequestNumber: state.number,
    repoPath: state.repoPath,
    octokit,
  };
  const reviewControl = {
    effective: effectiveReview,
    projectDefault: state.configuration.automaticReview.enabled,
    labels: state.pullRequest?.labels ?? [],
    reviewLabel: REVIEW_LABEL,
    skipReviewLabel: SKIP_REVIEW_LABEL,
  };
  const recentActivity = state.recentActivity.slice(-RECENT_ACTIVITY_LIMIT);
  return [
    "GitHub agent turn",
    "",
    `This is a bounded rendering. The exact triggering webhook is ${streamPath}@${input.sourceOffset}. If a summary omits fields you need, read only that raw fact with:`,
    "```js",
    `await itx.streams.get(${JSON.stringify(streamPath)}).getEvent({ offset: ${input.sourceOffset} })`,
    "```",
    "Other recent entries below include their raw offsets for the same point-read pattern. Do not bulk-load the stream into context.",
    "",
    "Current route and pull request:",
    "```yaml",
    yaml({ route, pullRequest: state.pullRequest, reviewControl }),
    "```",
    "",
    "Recent activity (bounded, oldest first):",
    "```yaml",
    yaml(recentActivity),
    "```",
    "",
    "Task:",
    ...tasks.map((task, index) => `${index + 1}. ${task}`),
  ].join("\n");
}

function activityFromWebhook(input: {
  body: Record<string, unknown>;
  createdAt: string;
  offset: number;
  payload: Record<string, unknown>;
}): GithubAgentProcessorState["recentActivity"][number] {
  const { body } = input;
  const kind = githubEventKind(input.payload, body);
  const action = readString(body.action);
  const actor = readString(readRecord(body.sender)?.login);
  const pullRequest = readRecord(body.pull_request);
  const comment = readRecord(body.comment);
  const review = readRecord(body.review);
  const checkRun = readRecord(body.check_run);
  const checkSuite = readRecord(body.check_suite);
  const workflowRun = readRecord(body.workflow_run);

  let summary: string;
  if (comment !== null) {
    const location = [
      readString(comment.path),
      readNumber(comment.line) === undefined ? undefined : `line ${readNumber(comment.line)}`,
    ]
      .filter(Boolean)
      .join(":");
    summary = [
      location === "" ? undefined : location,
      readString(comment.body),
      readString(comment.html_url),
    ]
      .filter(Boolean)
      .join(" — ");
  } else if (review !== null) {
    summary = [readString(review.state), readString(review.body), readString(review.html_url)]
      .filter(Boolean)
      .join(" — ");
  } else if (checkRun !== null) {
    summary = [
      readString(checkRun.name),
      readString(checkRun.status),
      readString(checkRun.conclusion),
      readString(checkRun.head_sha),
      readString(checkRun.details_url),
    ]
      .filter(Boolean)
      .join(" — ");
  } else if (checkSuite !== null) {
    summary = [
      "check suite",
      readString(checkSuite.status),
      readString(checkSuite.conclusion),
      readString(checkSuite.head_sha),
    ]
      .filter(Boolean)
      .join(" — ");
  } else if (workflowRun !== null) {
    summary = [
      readString(workflowRun.name),
      readString(workflowRun.status),
      readString(workflowRun.conclusion),
      readString(workflowRun.head_sha),
      readString(workflowRun.html_url),
    ]
      .filter(Boolean)
      .join(" — ");
  } else if (pullRequest !== null) {
    summary = [
      readString(pullRequest.title),
      readString(readRecord(pullRequest.head)?.sha),
      typeof pullRequest.draft === "boolean" ? `draft: ${pullRequest.draft}` : undefined,
    ]
      .filter(Boolean)
      .join(" — ");
  } else {
    summary = `${kind}${action === undefined ? "" : ` ${action}`}`;
  }

  return {
    ...(action === undefined ? {} : { action }),
    ...(actor === undefined ? {} : { actor }),
    at: input.createdAt,
    kind,
    offset: input.offset,
    summary: truncate(summary, MAX_ACTIVITY_SUMMARY_LENGTH) ?? kind,
  };
}

function githubEventKind(payload: Record<string, unknown>, body: Record<string, unknown>): string {
  const headers = readRecord(payload.headers);
  const headerKind = readString(headers?.githubEvent);
  if (headerKind !== undefined) return headerKind;
  if (readRecord(body.check_run) !== null) return "check_run";
  if (readRecord(body.check_suite) !== null) return "check_suite";
  if (readRecord(body.workflow_run) !== null) return "workflow_run";
  if (readRecord(body.review) !== null) return "pull_request_review";
  if (readRecord(body.comment) !== null && readRecord(body.issue) !== null) return "issue_comment";
  if (readRecord(body.comment) !== null) return "pull_request_review_comment";
  if (readRecord(body.pull_request) !== null) return "pull_request";
  return "webhook";
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[… ${value.length - limit} characters omitted; read the raw event by offset …]`;
}

function yaml(value: unknown): string {
  return stringifyYaml(JSON.parse(JSON.stringify(value))).trimEnd();
}
