import { setTimeout as sleep } from "node:timers/promises";
import { x } from "tinyexec";

const logger = console;

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

const CONSUMER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RECONNECT_DELAY_MS = 1000;

interface SlackRunContext {
  id: string;
  channel: string;
  threadTs: string;
  emojiTimestamp: string;
  emoji: string;
  requestId?: string;
}

interface SlackConsumerState {
  agentPath: string;
  runs: Map<string, SlackRunContext>;
  lastTouchedAt: number;
  reconnectAttempts: number;
  abortController: AbortController | null;
  active: boolean;
}

const consumers = new Map<string, SlackConsumerState>();

export async function registerSlackWork(params: {
  agentPath: string;
  channel: string;
  threadTs: string;
  emojiTimestamp: string;
  emoji: string;
  requestId?: string;
}): Promise<void> {
  const state = getOrCreateConsumer(params.agentPath);

  const run: SlackRunContext = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: params.channel,
    threadTs: params.threadTs,
    emojiTimestamp: params.emojiTimestamp,
    emoji: params.emoji,
    requestId: params.requestId,
  };

  state.runs.set(run.id, run);
  touch(state);

  await acknowledge(run);
}

function getOrCreateConsumer(agentPath: string): SlackConsumerState {
  const existing = consumers.get(agentPath);
  if (existing) {
    touch(existing);
    return existing;
  }

  const state: SlackConsumerState = {
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

function touch(state: SlackConsumerState): void {
  state.lastTouchedAt = Date.now();
}

async function runConsumerLoop(state: SlackConsumerState): Promise<void> {
  while (state.active) {
    if (isIdle(state)) {
      await settleAllRuns(state);
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
        await sleep(RECONNECT_DELAY_MS);
        continue;
      }

      state.reconnectAttempts = 0;
      await consumeSse(state, response.body.getReader());
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        state.reconnectAttempts += 1;
        logger.warn("[slack-consumer] stream error", {
          agentPath: state.agentPath,
          reconnectAttempts: state.reconnectAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      state.abortController = null;
    }

    if (isIdle(state)) {
      await settleAllRuns(state);
      shutdown(state);
      return;
    }

    await sleep(RECONNECT_DELAY_MS);
  }
}

async function consumeSse(
  state: SlackConsumerState,
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
        await handleSseFrame(state, rawEvent);
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleSseFrame(state: SlackConsumerState, rawFrame: string): Promise<void> {
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

  await handleOpencodeEvent(state, event as Record<string, unknown>);
}

async function handleOpencodeEvent(
  state: SlackConsumerState,
  event: Record<string, unknown>,
): Promise<void> {
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "session.idle" || type === "session.error") {
    await settleAllRuns(state);
    return;
  }

  if (type === "session.status") {
    const properties = isRecord(event.properties) ? event.properties : null;
    const status = properties && isRecord(properties.status) ? properties.status : null;
    const statusType = status && typeof status.type === "string" ? status.type : "";

    if (statusType === "idle") {
      await settleAllRuns(state);
    }
    return;
  }

  if (type !== "message.part.updated") return;

  const properties = isRecord(event.properties) ? event.properties : null;
  const part = properties && isRecord(properties.part) ? properties.part : null;
  if (!part || part.type !== "tool") return;

  const stateValue = isRecord(part.state) ? part.state : null;
  if (!stateValue) return;

  const toolInput = isRecord(stateValue.input) ? stateValue.input : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";

  // Don't overwrite status when the model itself is posting to Slack.
  if (command.includes("iterate tool slack")) return;

  const stateStatus = typeof stateValue.status === "string" ? stateValue.status : "";
  if (stateStatus !== "running" && stateStatus !== "completed") return;

  const title = typeof stateValue.title === "string" ? stateValue.title : "";
  const description = typeof toolInput.description === "string" ? toolInput.description : "";
  const tool = typeof part.tool === "string" ? part.tool : "";
  const statusText = (title || description || tool || "Working").slice(0, 30);

  for (const run of state.runs.values()) {
    await setThreadStatus(run, statusText);
  }
}

async function settleAllRuns(state: SlackConsumerState): Promise<void> {
  if (state.runs.size === 0) return;

  const runs = [...state.runs.values()];
  state.runs.clear();

  for (const run of runs) {
    await unacknowledge(run);
  }
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

function isIdle(state: SlackConsumerState): boolean {
  return Date.now() - state.lastTouchedAt > CONSUMER_IDLE_TIMEOUT_MS;
}

function shutdown(state: SlackConsumerState): void {
  state.active = false;
  state.abortController?.abort();
  state.abortController = null;
  consumers.delete(state.agentPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
