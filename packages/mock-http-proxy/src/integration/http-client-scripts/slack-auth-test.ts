import { WebClient } from "@slack/web-api";
import { buildForwardedHeader } from "@iterate-com/shared/forwarded-header";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const slackApiUrl = process.env.SLACK_API_URL ?? "https://slack.com/api/";
  const slackTargetUrl = process.env.SLACK_TARGET_URL ?? "https://slack.com";
  const slackTarget = new URL(slackTargetUrl);
  const forwarded = buildForwardedHeader({
    host: slackTarget.host,
    proto: slackTarget.protocol,
  });
  const client = new WebClient(required("SLACK_BOT_TOKEN"), {
    slackApiUrl,
    headers: process.env.SLACK_API_URL !== undefined && forwarded ? { forwarded } : undefined,
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
