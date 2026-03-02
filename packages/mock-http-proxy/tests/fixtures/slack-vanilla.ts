import { WebClient } from "@slack/web-api";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const client = new WebClient(required("SLACK_BOT_TOKEN"));
  const auth = await client.auth.test();

  process.stdout.write(
    `${JSON.stringify({
      ok: Boolean(auth.ok),
      endpoint: "slack.auth.test",
      teamId: auth.team_id ?? null,
      userId: auth.user_id ?? null,
    })}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
