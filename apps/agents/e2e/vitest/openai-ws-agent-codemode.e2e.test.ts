import {
  Event,
  type Event as EventsEvent,
  type StreamPath,
} from "@iterate-com/shared/streams/types";
import { expect, test } from "vitest";
import { setupE2E } from "../test-support/e2e-test.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";
import { streamPathToAgentInstance } from "~/lib/iterate-agent-addressing.ts";

const EXPECTED_WEBCHAT_MESSAGE = "OPENAI_WS_CODEMODE_OK";

test(
  "OpenAI WebSocket provider can drive a codemode webchat reply",
  { tags: ["local-dev-server", "live-internet", "slow"], timeout: 240_000 },
  async (ctx) => {
    const openAiApiKey = process.env.APP_CONFIG_OPEN_AI_API_KEY?.trim();
    if (!openAiApiKey) {
      throw new Error("APP_CONFIG_OPEN_AI_API_KEY is required for OpenAI WebSocket e2e proof.");
    }

    const e2e = await setupE2E(ctx);
    const streamPath = e2e.createStreamPath();
    const runnerInstance = streamPathToAgentInstance(streamPath);

    await using server = await createLocalDevServer({
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
      openAiApiKey,
      streamPath,
    });

    const sockets = await Promise.all(
      [
        "agent-stream-processor-runner",
        "openai-ws-stream-processor-runner",
        "codemode-stream-processor-runner",
      ].map(
        async (runnerSlug) =>
          await connectRunnerSocket({
            baseUrl: server.baseUrl,
            runnerInstance,
            runnerSlug,
            streamPath,
          }),
      ),
    );
    ctx.onTestFinished(() => {
      for (const socket of sockets) socket.close();
    });

    await e2e.events.append(streamPath, {
      type: "events.iterate.com/openai-ws/config-updated",
      payload: { model: "gpt-5.2" },
    });

    await e2e.events.append(streamPath, {
      type: "events.iterate.com/agent/input-added",
      payload: {
        content: `Respond with exactly this fenced JavaScript block and no other text:

\`\`\`js
async () => {
  await webchat.sendMessage({ message: "${EXPECTED_WEBCHAT_MESSAGE}" });
  return { ok: true };
}
\`\`\``,
      },
    });

    const { deltaEvent, completedEvent, webchatEvent } = await pumpRunnerSocketsUntil({
      events: e2e.events.client,
      path: streamPath,
      sockets,
      timeoutMs: 120_000,
    });

    expect(deltaEvent.offset).toBeGreaterThan(0);
    expect(completedEvent.offset).toBeGreaterThan(deltaEvent.offset);
    expect(webchatEvent.offset).toBeGreaterThan(completedEvent.offset);
  },
);

async function connectRunnerSocket(args: {
  baseUrl: string;
  runnerInstance: string;
  runnerSlug: string;
  streamPath: StreamPath;
}): Promise<WebSocket> {
  const url = new URL(args.baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/api/${args.runnerSlug}/${encodeURIComponent(args.runnerInstance)}/websocket`;
  url.search = "";
  url.searchParams.set("streamPath", args.streamPath);

  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`Failed to open runner websocket: ${url.toString()}`)),
      { once: true },
    );
  });
  return socket;
}

async function pumpRunnerSocketsUntil(args: {
  events: Awaited<ReturnType<typeof setupE2E>>["events"]["client"];
  path: StreamPath;
  sockets: WebSocket[];
  timeoutMs: number;
}) {
  const deadline = Date.now() + args.timeoutMs;
  let deliveredOffset = 0;
  let deltaEvent: EventsEvent | null = null;
  let completedEvent: EventsEvent | null = null;
  let webchatEvent: EventsEvent | null = null;

  while (Date.now() < deadline) {
    const events = await readFiniteStreamHistory(args.events, args.path);
    for (const event of events.filter((candidate) => candidate.offset > deliveredOffset)) {
      deliveredOffset = Math.max(deliveredOffset, event.offset);
      for (const socket of args.sockets) {
        socket.send(JSON.stringify({ type: "event", event }));
      }
    }

    deltaEvent =
      deltaEvent ??
      events.find((event) => {
        if (event.type !== "events.iterate.com/openai-ws/websocket-message-received") {
          return false;
        }
        const payload = event.payload as { message?: { type?: string } };
        return payload.message?.type === "response.output_text.delta";
      }) ??
      null;
    completedEvent =
      completedEvent ??
      events.find((event) => {
        if (event.type !== "events.iterate.com/agent/llm-request-completed") return false;
        const payload = event.payload as { provider?: string; result?: { status?: string } };
        return payload.provider === "openai-ws" && payload.result?.status === "success";
      }) ??
      null;
    webchatEvent =
      webchatEvent ??
      events.find((event) => {
        if (event.type !== "events.iterate.com/agent-chat/assistant-response-added") return false;
        const payload = event.payload as { message?: string };
        return payload.message === EXPECTED_WEBCHAT_MESSAGE;
      }) ??
      null;

    if (deltaEvent != null && completedEvent != null && webchatEvent != null) {
      return { deltaEvent, completedEvent, webchatEvent };
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const events = await readFiniteStreamHistory(args.events, args.path);
  throw new Error(
    `Timed out waiting for OpenAI WS codemode proof; last types: ${events.map((event) => event.type).join(", ")}`,
  );
}

async function readFiniteStreamHistory(
  client: Awaited<ReturnType<typeof setupE2E>>["events"]["client"],
  path: StreamPath,
): Promise<EventsEvent[]> {
  const stream = await client.stream({
    path,
    afterOffset: "start",
    beforeOffset: "end",
  });
  const events: EventsEvent[] = [];
  for await (const value of stream) {
    events.push(Event.parse(value));
  }
  return events;
}
