import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { slackServiceManifest } from "@iterate-com/slack-contract";
import { Hono } from "hono";

const env = slackServiceManifest.envVars.parse(process.env);
const app = new Hono();

function sanitizeThreadTs(threadTs: string): string {
  return threadTs.replace(/\./g, "-");
}

function toAgentPath(threadTs: string): string {
  return `/slack/ts-${sanitizeThreadTs(threadTs)}`;
}

app.get("/healthz", (c) => c.text("ok"));

app.post("/agent-change-callback", async (c) => {
  await c.req.text();
  return c.json({ ok: true });
});

app.post("/webhook", async (c) => {
  const body = (await c.req.json()) as {
    event?: {
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      type?: string;
      user?: string;
    };
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };

  const event = body.event ?? body;
  const threadTs = event.thread_ts ?? event.ts;
  const channel = event.channel;
  const text = event.text ?? "";

  if (!threadTs || !channel || text.trim().length === 0) {
    return c.json({ error: "thread_ts/ts, channel, and text are required" }, 400);
  }

  const agentPath = toAgentPath(threadTs);

  const forward = await fetch(`${env.AGENTS_SERVICE_BASE_URL}/api/agents/forward${agentPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "iterate:agent:prompt-added", message: text }],
      slack: {
        channel,
        threadTs,
      },
    }),
  });

  if (!forward.ok) {
    return c.json({ error: `agents forward failed: ${await forward.text()}` }, 502);
  }

  return c.json({
    ok: true as const,
    queued: true,
    agentPath,
    threadTs,
  });
});

export const startSlackService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => {
    server.listen(env.SLACK_SERVICE_PORT, "0.0.0.0", () => resolve());
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startSlackService();
}
