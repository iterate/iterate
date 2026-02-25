import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { opencodeWrapperServiceManifest } from "@iterate-com/opencode-wrapper-contract";
import { Hono } from "hono";

interface SessionRecord {
  id: string;
  agentPath: string;
  createdAt: string;
}

const env = opencodeWrapperServiceManifest.envVars.parse(process.env);
const sessions = new Map<string, SessionRecord>();
const app = new Hono();

function extractPrompt(events: Array<{ type?: string; message?: string }> | undefined): string {
  if (!events || events.length === 0) return "";
  const prompts = events
    .filter((event) => event.type === "iterate:agent:prompt-added")
    .map((event) => event.message ?? "")
    .filter((value) => value.trim().length > 0);
  return prompts.join("\n\n");
}

async function callModel(prompt: string): Promise<string> {
  const response = await fetch(`${env.OPENAI_BASE_URL}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "test-key"}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL,
      input: prompt,
    }),
  });

  if (!response.ok) {
    throw new Error(`openai failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }

  const textFromOutput = payload.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text)
    .find((value): value is string => typeof value === "string" && value.length > 0);

  return textFromOutput ?? "No response text returned.";
}

async function postSlackMessage(payload: {
  channel: string;
  thread_ts: string;
  text: string;
}): Promise<void> {
  const response = await fetch(`${env.SLACK_API_BASE_URL}/api/chat.postMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN ?? "xoxb-test"}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`slack failed: ${response.status} ${await response.text()}`);
  }

  const payloadJson = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
  } | null;
  if (payloadJson?.ok === false) {
    throw new Error(`slack failed: ${payloadJson.error ?? "unknown error"}`);
  }
}

app.get("/healthz", (c) => c.text("ok"));

app.post("/new", async (c) => {
  const body = (await c.req.json()) as { agentPath?: string };
  const agentPath = body.agentPath?.trim();
  if (!agentPath) return c.json({ error: "agentPath is required" }, 400);

  await fetch(`${env.OPENCODE_BASE_URL}/healthz`).catch(() => {
    // opencode process is best-effort in this minimal wrapper
  });

  const sessionId = randomUUID();
  sessions.set(sessionId, {
    id: sessionId,
    agentPath,
    createdAt: new Date().toISOString(),
  });

  return c.json({
    route: `/sessions/${sessionId}`,
    sessionId,
  });
});

app.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "session not found" }, 404);

  const body = (await c.req.json()) as {
    events?: Array<{ type?: string; message?: string }>;
    slack?: { channel?: string; threadTs?: string };
  };

  const prompt = extractPrompt(body.events);
  if (!prompt) return c.json({ error: "missing prompt-added event" }, 400);

  await fetch(`${env.AGENTS_SERVICE_BASE_URL}/api/agents/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: session.agentPath, isWorking: true, shortStatus: "Thinking" }),
  }).catch(() => {});

  try {
    const modelResponse = await callModel(prompt);

    if (body.slack?.channel && body.slack?.threadTs) {
      const slackPayload = {
        channel: body.slack.channel,
        thread_ts: body.slack.threadTs,
        text: modelResponse,
      };
      await postSlackMessage(slackPayload);
    }
  } finally {
    await fetch(`${env.AGENTS_SERVICE_BASE_URL}/api/agents/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: session.agentPath, isWorking: false, shortStatus: "" }),
    }).catch(() => {});
  }

  return c.json({ ok: true as const });
});

export const startOpencodeWrapperService = async () => {
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => {
    server.listen(env.OPENCODE_WRAPPER_SERVICE_PORT, "0.0.0.0", () => resolve());
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
  void startOpencodeWrapperService();
}
