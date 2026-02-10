import { x } from "tinyexec";
import type { AgentLifecycleEvent } from "./agent-lifecycle.ts";

const logger = console;

interface SlackRunContext {
  channel: string;
  threadTs: string;
  emojiTimestamp: string;
  emoji: string;
  requestId?: string;
}

const consumers = new Map<
  string,
  {
    run: SlackRunContext;
  }
>();
const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

export function trackSlackLifecycle(params: {
  agentPath: string;
  channel: string;
  threadTs: string;
  emojiTimestamp: string;
  emoji: string;
  requestId?: string;
}): void {
  const run: SlackRunContext = {
    channel: params.channel,
    threadTs: params.threadTs,
    emojiTimestamp: params.emojiTimestamp,
    emoji: params.emoji,
    requestId: params.requestId,
  };

  const existing = consumers.get(params.agentPath);
  if (existing) {
    existing.run = run;
    return;
  }

  const consumer = { run };
  consumers.set(params.agentPath, consumer);
  void runLifecycleConsumerLoop(params.agentPath, consumer);
}

async function acknowledge(run: SlackRunContext): Promise<void> {
  try {
    await runSlackCommand(
      `await slack.reactions.add(${JSON.stringify({
        channel: run.channel,
        timestamp: run.emojiTimestamp,
        name: run.emoji,
      })})`,
      run.requestId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already_reacted")) {
      logger.error("[slack-consumer] acknowledge failed", { run, error: message });
    }
  }
}

async function unacknowledge(run: SlackRunContext): Promise<void> {
  try {
    await runSlackCommand(
      `await slack.reactions.remove(${JSON.stringify({
        channel: run.channel,
        timestamp: run.emojiTimestamp,
        name: run.emoji,
      })})`,
      run.requestId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("no_reaction")) {
      logger.error("[slack-consumer] unacknowledge failed", { run, error: message });
    }
  }

  await setThreadStatus(run, "");
}

async function setThreadStatus(run: SlackRunContext, status: string): Promise<void> {
  try {
    await runSlackCommand(
      `await slack.assistant.threads.setStatus(${JSON.stringify({
        channel_id: run.channel,
        thread_ts: run.threadTs,
        status,
      })})`,
      run.requestId,
    );
  } catch (error) {
    logger.error("[slack-consumer] setStatus failed", {
      run,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runSlackCommand(code: string, requestId?: string): Promise<void> {
  const result = await x("iterate", ["tool", "slack", code], { throwOnError: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Exit code ${result.exitCode}`);
  }

  logger.log("[slack-consumer] ran slack command", {
    requestId,
    preview: code.slice(0, 80),
  });
}

async function runLifecycleConsumerLoop(
  agentPath: string,
  consumer: { run: SlackRunContext },
): Promise<void> {
  while (consumers.get(agentPath) === consumer) {
    try {
      const response = await fetch(`${DAEMON_BASE_URL}/api/agents${agentPath}/lifecycle`, {
        headers: { Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) {
        await sleepMs(1000);
        continue;
      }

      await consumeSse(response.body, async (event) => {
        if (event.type === "ack") {
          await acknowledge(consumer.run);
          return;
        }
        if (event.type === "status") {
          await setThreadStatus(consumer.run, event.status);
          return;
        }
        if (event.type === "unack") {
          await unacknowledge(consumer.run);
        }
      });
    } catch {
      // Best-effort lifecycle side effects; reconnect below.
    }

    await sleepMs(1000);
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentLifecycleEvent) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseLifecycleFrame(frame);
        if (event) {
          await onEvent(event);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseLifecycleFrame(frame: string): AgentLifecycleEvent | null {
  const dataLines = frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return null;

  const payload = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
  if (!payload || payload === "[DONE]") return null;

  try {
    const parsed = JSON.parse(payload) as AgentLifecycleEvent;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.type === "string" &&
      (parsed.type === "ack" || parsed.type === "status" || parsed.type === "unack")
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
