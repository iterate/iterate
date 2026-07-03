import { getRunUrl } from "./github.ts";
import { isMainModule } from "./main-module.ts";
import { getSlackClient, resolveSlackChannel, slackChannelIds } from "./slack.ts";

type DeployOptions = {
  app: string;
  status: "success" | "failure";
  shortSha: string;
  runUrl: string;
  publicUrl?: string;
  channel?: string;
};

export async function notifyDeploy({
  app,
  status,
  shortSha,
  runUrl,
  publicUrl,
  channel = "#ci",
}: DeployOptions) {
  const slack = getSlackClient();
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
          `${failureIcon()} ${app} prd deploy failed (${shortSha}).`,
          `<${runUrl}|View workflow run>`,
          "@iterate please investigate",
        ].join(" ");

  await slack.chat.postMessage({
    channel: resolveSlackChannel(channel),
    text: message,
  });
}

export async function notifyWorkflowFailure() {
  const needs = JSON.parse(process.env.NEEDS || "{}") as Record<string, { result?: string }>;
  const failedJobs = Object.entries(needs)
    .filter(([, value]) => value.result === "failure")
    .map(([name]) => name);

  const refName = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || "unknown ref";
  const message = [
    `${failureIcon()} ${failedJobs.join(", ")} failed on ${refName}.`,
    `<${getRunUrl()}|View Workflow Run>`,
    "\n@iterate please investigate",
  ].join(" ");

  await getSlackClient().chat.postMessage({
    channel: slackChannelIds["#error-pulse"],
    text: message,
  });
}

function failureIcon() {
  return "🚨";
}

function readOption(name: string, fallback?: string) {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const command = process.argv[2];
  if (command === "deploy-success" || command === "deploy-failure") {
    await notifyDeploy({
      app: readOption("APP_DISPLAY_NAME"),
      status: command === "deploy-success" ? "success" : "failure",
      shortSha: readOption("SHORT_SHA"),
      runUrl: readOption("RUN_URL", getRunUrl()),
      publicUrl: process.env.PUBLIC_URL,
      channel: process.env.SLACK_CHANNEL_NAME || "#ci",
    });
    return;
  }

  if (command === "workflow-failure") {
    await notifyWorkflowFailure();
    return;
  }

  throw new Error(`Unknown notify command: ${command || "(missing)"}`);
}

if (isMainModule(import.meta.url)) {
  await main();
}
