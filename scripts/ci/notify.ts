import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getRunUrl } from "./github.ts";
import { getSlackClient, slackChannelIds } from "./slack.ts";

type DeployOptions = {
  app: string;
  status: "success" | "failure";
  commitSha: string;
  runUrl: string;
  publicUrl?: string;
};

export async function notifyDeploy({ app, status, commitSha, runUrl, publicUrl }: DeployOptions) {
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

export async function notifyWorkflowFailure() {
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

function readOption(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const command = process.argv[2];
  if (command === "deploy-success" || command === "deploy-failure") {
    await notifyDeploy({
      app: readOption("APP_DISPLAY_NAME"),
      status: command === "deploy-success" ? "success" : "failure",
      commitSha: readOption("GITHUB_SHA"),
      runUrl: getRunUrl(),
      publicUrl: process.env.PUBLIC_URL,
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
