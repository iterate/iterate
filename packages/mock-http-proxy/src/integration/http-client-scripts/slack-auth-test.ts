import { WebClient } from "@slack/web-api";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const slackApiUrl = process.env.SLACK_API_URL ?? "https://slack.com/api/";
  const slackTargetUrl = process.env.SLACK_TARGET_URL ?? "https://slack.com";
  const slackTarget = new URL(slackTargetUrl);

  const headers: Record<string, string> | undefined =
    process.env.SLACK_API_URL !== undefined
      ? {
          "x-forwarded-host": slackTarget.host,
          "x-forwarded-proto": slackTarget.protocol.replace(/:$/, ""),
        }
      : undefined;

  const client = new WebClient(required("SLACK_BOT_TOKEN"), {
    slackApiUrl,
    headers,
  });
  const auth = await client.auth.test();

  process.stdout.write(
    `${JSON.stringify({
      ok: Boolean(auth.ok),
      endpoint: "slack.auth.test",
      teamId: auth.team_id ?? null,
      userId: auth.user_id ?? null,
    })}\n`,
  );
  process.exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
