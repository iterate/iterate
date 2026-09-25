import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { getRunUrl, readEventPayload, type GithubEventPayload } from "./github.ts";
import { getSlackClient, slackChannelIds, slackEscape } from "./slack.ts";

type DeployOptions = {
  app: string;
  status: "success" | "failure";
  commitSha: string;
  runUrl: string;
  publicUrl?: string;
};

type PullRequestPayload = NonNullable<GithubEventPayload["pull_request"]>;

async function notifyDeploy({ app, status, commitSha, runUrl, publicUrl }: DeployOptions) {
  const slack = getSlackClient();
  const shortSha = commitSha.slice(0, 7);
  const message =
    status === "success"
      ? [
          `✅ ${app} prd deploy succeeded (${shortSha})`,
          publicUrl ? `<${publicUrl}|Open app>` : null,
          `<${runUrl}|View workflow run>`,
        ]
          .filter(Boolean)
          .join(" · ")
      : [
          `🚨 ${app} prd deploy failed (${shortSha}).`,
          `<${runUrl}|View workflow run>`,
          "@iterate please investigate",
        ].join(" ");

  await slack.chat.postMessage({
    channel: slackChannelIds["#ci"],
    text: message,
  });
}

async function notifyWorkflowFailure() {
  const needs = JSON.parse(readOption("NEEDS")) as Record<string, { result?: string }>;
  const failedJobs = Object.entries(needs)
    .filter(([, value]) => value.result === "failure")
    .map(([name]) => name);

  const refName = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || "unknown ref";
  const message = [
    `🚨 ${failedJobs.join(", ")} failed on ${refName}.`,
    `<${getRunUrl()}|View Workflow Run>`,
    "\n@iterate please investigate",
  ].join(" ");

  await getSlackClient().chat.postMessage({
    channel: slackChannelIds["#error-pulse"],
    text: message,
  });
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

function formatPullRequestUpdateMessage(payload: GithubEventPayload) {
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

function readOption(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Posts the prd deploy success line for APP_DISPLAY_NAME at GITHUB_SHA (PUBLIC_URL links the app). */
export async function deploySuccess() {
  await notifyDeploy({
    app: readOption("APP_DISPLAY_NAME"),
    status: "success",
    commitSha: readOption("GITHUB_SHA"),
    runUrl: getRunUrl(),
    publicUrl: process.env.PUBLIC_URL,
  });
}

/** Posts the prd deploy failure page for APP_DISPLAY_NAME at GITHUB_SHA. */
export async function deployFailure() {
  await notifyDeploy({
    app: readOption("APP_DISPLAY_NAME"),
    status: "failure",
    commitSha: readOption("GITHUB_SHA"),
    runUrl: getRunUrl(),
    publicUrl: process.env.PUBLIC_URL,
  });
}

/** Posts the failed workflow run to Slack. */
export async function workflowFailure() {
  await notifyWorkflowFailure();
}

/** Posts the pull request event (GITHUB_EVENT_PATH) to Slack. */
export async function prUpdate() {
  await notifyPullRequestUpdate();
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "notify" }).run();
