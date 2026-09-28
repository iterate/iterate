import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { getRunUrl, readEventPayload, type GithubEventPayload } from "./github.ts";
import { getSlackClient, onCallMention, slackChannelIds, slackEscape } from "./slack.ts";

type DeployOptions = {
  app: string;
  status: "success" | "failure";
  commitSha: string;
  runUrl: string;
  publicUrl?: string;
};

type PullRequestPayload = NonNullable<GithubEventPayload["pull_request"]>;

/** A prd deploy's post: a success is routine, for #ci; a failure pages #error-pulse. Pure. */
export function deployMessage({ app, status, commitSha, runUrl, publicUrl }: DeployOptions) {
  const shortSha = commitSha.slice(0, 7);
  if (status === "success")
    return {
      channel: slackChannelIds["#ci"],
      text: [
        `✅ ${app} prd deploy succeeded (${shortSha})`,
        publicUrl ? `<${publicUrl}|Open app>` : null,
        `<${runUrl}|View workflow run>`,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  return {
    channel: slackChannelIds["#error-pulse"],
    text: `🚨 ${app} prd deploy failed (${shortSha}) ${onCallMention}\n<${runUrl}|View workflow run>`,
  };
}

/** A workflow's `toJSON(needs)`: each job it waited on, with its result. */
const WorkflowNeeds = z.record(z.string(), z.object({ result: z.string().optional() }));

/** The page for a workflow whose jobs failed. Pure. */
export function workflowFailureMessage(input: {
  needs: z.infer<typeof WorkflowNeeds>;
  refName: string;
  runUrl: string;
}) {
  const failedJobs = Object.entries(input.needs)
    .filter(([, value]) => value.result === "failure")
    .map(([name]) => name);
  return {
    channel: slackChannelIds["#error-pulse"],
    text: `🚨 ${failedJobs.join(", ")} failed on ${input.refName} ${onCallMention}\n<${input.runUrl}|View Workflow Run>`,
  };
}

async function notifyPullRequestUpdate() {
  const payload = readEventPayload();
  const message = formatPullRequestUpdateMessage(payload);
  if (!message) {
    console.log(`No #ci Slack PR update for pull_request action ${payload.action || "(missing)"}`);
    return;
  }

  await getSlackClient().chat.postMessage({
    channel: slackChannelIds["#ci"],
    text: message,
  });
}

/** A pull request event's routine post for #ci, or null for an action it does not post. Pure. */
export function formatPullRequestUpdateMessage(payload: GithubEventPayload) {
  const pullRequest = payload.pull_request;
  if (!pullRequest) {
    throw new Error("pull_request payload is required");
  }

  const detail = formatPullRequestUpdateDetail(payload.action, pullRequest);
  if (!detail) return null;

  const actor = getPullRequestActionActor(payload, pullRequest);
  const author = pullRequest.user?.login;
  const authorSuffix = author && author !== actor ? ` (author: ${slackEscape(author)})` : "";
  const link = formatPullRequestLink(pullRequest);

  return `${detail.prefix}: ${link}${detail.afterLink || ""} by ${slackEscape(actor)}${detail.afterActor || ""}${authorSuffix}`;
}

function formatPullRequestUpdateDetail(
  action: string | undefined,
  pullRequest: PullRequestPayload,
) {
  switch (action) {
    case "opened":
      return { prefix: `🟢 PR opened${pullRequest.draft ? " as draft" : ""}` };
    case "reopened":
      return { prefix: `🔁 PR reopened${pullRequest.draft ? " as draft" : ""}` };
    case "ready_for_review":
      return { prefix: "👀 PR marked ready for review" };
    case "converted_to_draft":
      return { prefix: "📝 PR converted to draft" };
    case "closed":
      if (pullRequest.merged) {
        return {
          prefix: "✅ PR merged",
          afterLink: pullRequest.base?.ref ? ` into \`${slackEscape(pullRequest.base.ref)}\`` : "",
          afterActor: pullRequest.merge_commit_sha
            ? ` (${pullRequest.merge_commit_sha.slice(0, 7)})`
            : "",
        };
      }
      return { prefix: "⚪ PR closed without merge" };
    default:
      return null;
  }
}

function getPullRequestActionActor(payload: GithubEventPayload, pullRequest: PullRequestPayload) {
  return (
    (payload.action === "closed" && pullRequest.merged
      ? pullRequest.merged_by?.login
      : undefined) ||
    payload.sender?.login ||
    process.env.GITHUB_ACTOR ||
    pullRequest.user?.login ||
    "unknown"
  );
}

function formatPullRequestLink(pullRequest: PullRequestPayload) {
  const title = pullRequest.title ? ` ${slackEscape(pullRequest.title)}` : "";
  const label = `#${pullRequest.number}${title}`;
  return pullRequest.html_url ? `<${pullRequest.html_url}|${label}>` : label;
}

/** The deploy a prd deploy workflow's Notify step names: APP_DISPLAY_NAME at GITHUB_SHA, PUBLIC_URL
 *  linking the app. */
function deployOptions() {
  return {
    app: readOption("APP_DISPLAY_NAME"),
    commitSha: readOption("GITHUB_SHA"),
    runUrl: getRunUrl(),
    publicUrl: process.env.PUBLIC_URL,
  };
}

function readOption(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Posts the prd deploy success line for APP_DISPLAY_NAME at GITHUB_SHA to #ci (PUBLIC_URL links the app). */
export async function deploySuccess() {
  await getSlackClient().chat.postMessage(deployMessage({ ...deployOptions(), status: "success" }));
}

/** Pages #error-pulse with the prd deploy failure of APP_DISPLAY_NAME at GITHUB_SHA. */
export async function deployFailure() {
  await getSlackClient().chat.postMessage(deployMessage({ ...deployOptions(), status: "failure" }));
}

/** Pages #error-pulse with the workflow's failed jobs (NEEDS). */
export async function workflowFailure() {
  await getSlackClient().chat.postMessage(
    workflowFailureMessage({
      needs: WorkflowNeeds.parse(JSON.parse(readOption("NEEDS"))),
      refName: process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || "unknown ref",
      runUrl: getRunUrl(),
    }),
  );
}

/** Posts the pull request event (GITHUB_EVENT_PATH) to Slack. */
export async function prUpdate() {
  await notifyPullRequestUpdate();
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "notify" }).run();
