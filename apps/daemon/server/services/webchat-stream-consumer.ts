import { setTimeout as sleep } from "node:timers/promises";

const logger = console;

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

const CONSUMER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 12;

interface WebchatRunContext {
  id: string;
  threadId: string;
  messageId: string;
}

interface WebchatConsumerState {
  agentPath: string;
  runs: Map<string, WebchatRunContext>;
  lastTouchedAt: number;
  reconnectAttempts: number;
  abortController: AbortController | null;
  active: boolean;
}

const consumers = new Map<string, WebchatConsumerState>();
const threadStatuses = new Map<string, string>();

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

export function registerWebchatWork(params: {
  agentPath: string;
  threadId: string;
  messageId: string;
}): void {
  const state = getOrCreateConsumer(params.agentPath);

  const run: WebchatRunContext = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    threadId: params.threadId,
    messageId: params.messageId,
  };

  state.runs.set(run.id, run);
  touch(state);
}

function getOrCreateConsumer(agentPath: string): WebchatConsumerState {
  const existing = consumers.get(agentPath);
  if (existing) {
    touch(existing);
    return existing;
  }

  const state: WebchatConsumerState = {
    agentPath,
    runs: new Map(),
    lastTouchedAt: Date.now(),
    reconnectAttempts: 0,
    abortController: null,
    active: true,
  };
  consumers.set(agentPath, state);
  void runConsumerLoop(state);
  return state;
}

function touch(state: WebchatConsumerState): void {
  state.lastTouchedAt = Date.now();
}

async function runConsumerLoop(state: WebchatConsumerState): Promise<void> {
  while (state.active) {
    if (isIdle(state)) {
      settleAllRuns(state);
      shutdown(state);
      return;
    }

    state.abortController = new AbortController();

    try {
      const response = await fetch(`${DAEMON_BASE_URL}/api/agents${state.agentPath}`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: state.abortController.signal,
      });

      if (!response.ok || !response.body) {
        state.reconnectAttempts += 1;
        if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          logger.warn("[webchat-consumer] giving up after repeated connect failures", {
            agentPath: state.agentPath,
            reconnectAttempts: state.reconnectAttempts,
          });
          settleAllRuns(state);
          shutdown(state);
          return;
        }
        await sleep(getReconnectDelayMs(state.reconnectAttempts));
        continue;
      }

      state.reconnectAttempts = 0;
      await consumeSse(state, response.body.getReader());
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        state.reconnectAttempts += 1;
        logger.warn("[webchat-consumer] stream error", {
          agentPath: state.agentPath,
          reconnectAttempts: state.reconnectAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          logger.warn("[webchat-consumer] giving up after repeated stream errors", {
            agentPath: state.agentPath,
            reconnectAttempts: state.reconnectAttempts,
          });
          settleAllRuns(state);
          shutdown(state);
          return;
        }
      }
    } finally {
      state.abortController = null;
    }

    if (isIdle(state)) {
      settleAllRuns(state);
      shutdown(state);
      return;
    }

    await sleep(getReconnectDelayMs(state.reconnectAttempts));
  }
}

async function consumeSse(
  state: WebchatConsumerState,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (isIdle(state)) {
        state.abortController?.abort();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      touch(state);
      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        handleSseFrame(state, rawEvent);
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function handleSseFrame(state: WebchatConsumerState, rawFrame: string): void {
  const lines = rawFrame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"));

  if (lines.length === 0) return;

  const data = lines.map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return;

  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }

  handleOpencodeEvent(state, event as Record<string, unknown>);
}

function handleOpencodeEvent(state: WebchatConsumerState, event: Record<string, unknown>): void {
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "session.idle" || type === "session.error") {
    settleAllRuns(state);
    return;
  }

  if (type === "session.status") {
    const properties = isRecord(event.properties) ? event.properties : null;
    const status = properties && isRecord(properties.status) ? properties.status : null;
    const statusType = status && typeof status.type === "string" ? status.type : "";

    if (statusType === "idle") {
      settleAllRuns(state);
    }
    return;
  }

  if (type !== "message.part.updated") return;

  const properties = isRecord(event.properties) ? event.properties : null;
  const part = properties && isRecord(properties.part) ? properties.part : null;
  if (!part || part.type !== "tool") return;

  const stateValue = isRecord(part.state) ? part.state : null;
  if (!stateValue) return;

  const stateStatus = typeof stateValue.status === "string" ? stateValue.status : "";
  if (stateStatus !== "running" && stateStatus !== "completed") return;

  const toolInput = isRecord(stateValue.input) ? stateValue.input : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";

  // Skip status updates for direct webchat tool sends.
  if (command.includes("iterate tool webchat")) return;

  const title = typeof stateValue.title === "string" ? stateValue.title : "";
  const description = typeof toolInput.description === "string" ? toolInput.description : "";
  const tool = typeof part.tool === "string" ? part.tool : "";
  const statusText = (title || description || tool || "Working").slice(0, 30);

  for (const run of state.runs.values()) {
    setWebchatThreadStatus(run.threadId, statusText);
  }
}

function settleAllRuns(state: WebchatConsumerState): void {
  if (state.runs.size === 0) return;

  for (const run of state.runs.values()) {
    setWebchatThreadStatus(run.threadId, "");
  }

  state.runs.clear();
}

function isIdle(state: WebchatConsumerState): boolean {
  return Date.now() - state.lastTouchedAt > CONSUMER_IDLE_TIMEOUT_MS;
}

function shutdown(state: WebchatConsumerState): void {
  state.active = false;
  state.abortController?.abort();
  state.abortController = null;
  consumers.delete(state.agentPath);
}

function getReconnectDelayMs(attempts: number): number {
  const delay = RECONNECT_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
