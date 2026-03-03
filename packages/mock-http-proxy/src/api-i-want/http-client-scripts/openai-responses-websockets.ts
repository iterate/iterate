import OpenAI from "openai";
import { OpenAIRealtimeWebSocket } from "openai/realtime/websocket";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.floor(parsed);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function main() {
  const apiKey = required("OPENAI_API_KEY");
  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-mini-realtime-preview";
  const timeoutMs = parseTimeoutMs(process.env.OPENAI_REALTIME_TIMEOUT_MS, 4_000);
  const updateCount = parsePositiveInt(process.env.OPENAI_REALTIME_UPDATE_COUNT, 2);

  const client = new OpenAI({ apiKey, timeout: timeoutMs });
  const socket = await Promise.race([
    OpenAIRealtimeWebSocket.create(client, { model }),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`timed out creating realtime websocket after ${String(timeoutMs)}ms`));
      }, timeoutMs);
    }),
  ]);

  const closeSocket = () => {
    const rawSocket = socket.socket as unknown as { terminate?: () => void };
    if (typeof rawSocket.terminate === "function") {
      rawSocket.terminate();
      return;
    }
    socket.close();
  };

  const result = await new Promise<{
    eventType: string;
    eventTypes: string[];
    sendCount: number;
    receiveEventCount: number;
    sessionUpdatedCount: number;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      done(() => {
        closeSocket();
        reject(new Error(`timed out waiting for realtime event after ${String(timeoutMs)}ms`));
      });
    }, timeoutMs);

    const eventTypes: string[] = [];
    let nextUpdateToSend = 0;
    let sendCount = 0;
    let receiveEventCount = 0;
    let sessionUpdatedCount = 0;
    let finished = false;
    const done = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      fn();
    };

    const maybeSendNextUpdate = () => {
      if (nextUpdateToSend >= updateCount) return;
      nextUpdateToSend += 1;
      sendCount += 1;
      socket.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: `Say ok ${String(nextUpdateToSend)}`,
        },
      });
    };

    socket.on("error", (error) => {
      done(() => reject(error));
    });

    socket.on("event", (event) => {
      receiveEventCount += 1;
      eventTypes.push(event.type);

      if (event.type === "session.updated") {
        sessionUpdatedCount += 1;
      }

      if (sendCount >= updateCount && receiveEventCount >= 2) {
        done(() => {
          closeSocket();
          resolve({
            eventType: event.type,
            eventTypes,
            sendCount,
            receiveEventCount,
            sessionUpdatedCount,
          });
        });
        return;
      }

      if (event.type === "session.created" || event.type === "session.updated") {
        maybeSendNextUpdate();
      }
    });

    if (socket.socket.readyState === 1) {
      maybeSendNextUpdate();
    } else {
      socket.socket.addEventListener(
        "open",
        () => {
          maybeSendNextUpdate();
        },
        { once: true },
      );
    }
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      endpoint: "openai.websocket-mode",
      eventType: result.eventType,
      eventTypes: result.eventTypes,
      sendCount: result.sendCount,
      receiveEventCount: result.receiveEventCount,
      sessionUpdatedCount: result.sessionUpdatedCount,
      updateCount,
      model,
      timeoutMs,
    })}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
