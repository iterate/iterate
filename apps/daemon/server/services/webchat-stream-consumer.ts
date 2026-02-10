import type { AgentLifecycleEvent } from "./agent-lifecycle.ts";

const threadStatuses = new Map<string, string>();
const consumers = new Map<string, { threadId: string }>();
const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

export function getWebchatThreadStatus(threadId: string): string {
  return threadStatuses.get(threadId) ?? "";
}

export function setWebchatThreadStatus(threadId: string, status: string): void {
  if (status) {
    threadStatuses.set(threadId, status);
  } else {
    threadStatuses.delete(threadId);
  }
}

export function trackWebchatLifecycle(params: { agentPath: string; threadId: string }): void {
  const existing = consumers.get(params.agentPath);
  if (existing) {
    existing.threadId = params.threadId;
    return;
  }

  const consumer = { threadId: params.threadId };
  consumers.set(params.agentPath, consumer);
  void runLifecycleConsumerLoop(params.agentPath, consumer);
}

async function runLifecycleConsumerLoop(
  agentPath: string,
  consumer: { threadId: string },
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

      await consumeSse(response.body, (event) => {
        if (event.type === "ack") {
          setWebchatThreadStatus(consumer.threadId, "Working");
        } else if (event.type === "status") {
          setWebchatThreadStatus(consumer.threadId, event.status);
        } else if (event.type === "unack") {
          setWebchatThreadStatus(consumer.threadId, "");
        }
      });
    } catch {
      // Best-effort status updates; reconnect below.
    }
    await sleepMs(1000);
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentLifecycleEvent) => void,
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
        if (event) onEvent(event);
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
