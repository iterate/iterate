import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI from "openai";
import type {
  ResponsesClientEvent,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import { ResponsesWS } from "openai/resources/responses/ws";

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

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy
  );
}

function responseIdFromEvent(event: Record<string, unknown>): string | undefined {
  const response = event.response;
  if (!response || typeof response !== "object") return undefined;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function userMessage(text: string): string {
  return text;
}

async function main() {
  const apiKey = required("OPENAI_API_KEY");
  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-5.2";
  const timeoutMs = parseTimeoutMs(process.env.OPENAI_REALTIME_TIMEOUT_MS, 4_000);

  const proxyUrl = getProxyUrl();
  const debugEvents = process.env.OPENAI_RESPONSES_WS_DEBUG === "1";
  const client = new OpenAI({ apiKey });
  const ws = new ResponsesWS(client, {
    ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
  });

  const closeSocket = () => {
    ws.close();
    if (ws.socket.readyState !== 3) {
      ws.socket.terminate();
    }
  };

  const result = await new Promise<{
    eventType: string;
    eventTypes: string[];
    sendCount: number;
    receiveEventCount: number;
    completedCount: number;
    responseChain: string[];
    responseTexts: string[];
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      done(() => {
        closeSocket();
        reject(new Error(`timed out waiting for websocket events after ${String(timeoutMs)}ms`));
      });
    }, timeoutMs);

    const eventTypes: string[] = [];
    const responseChain: string[] = [];
    const responseTexts: string[] = [];
    let currentResponseText = "";
    let sendCount = 0;
    let receiveEventCount = 0;
    let completedCount = 0;
    let latestResponseId: string | undefined;
    let phase: "warmup" | "generate" = "warmup";
    let finished = false;

    const done = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      fn();
    };

    const sendEvent = (event: ResponsesClientEvent) => {
      ws.send(event);
      sendCount += 1;
    };

    const sendWarmup = () => {
      sendEvent({
        type: "response.create",
        model,
        input: userMessage("Ping."),
      });
    };

    const sendGenerate = (previousResponseId: string) => {
      sendEvent({
        type: "response.create",
        model,
        previous_response_id: previousResponseId,
        input: userMessage("Reply with exactly OK."),
      });
    };

    ws.socket.on("open", () => {
      sendWarmup();
    });

    ws.on("error", (error) => {
      done(() => {
        closeSocket();
        reject(error);
      });
    });

    ws.on("event", (event: ResponsesServerEvent) => {
      receiveEventCount += 1;
      const eventType = event.type;
      if (typeof eventType !== "string") return;
      eventTypes.push(eventType);
      if (debugEvents) {
        process.stderr.write(`[responses-ws] event=${eventType}\n`);
      }

      if (eventType === "error") {
        done(() => {
          closeSocket();
          reject(new Error(`websocket server error event: ${JSON.stringify(event ?? null)}`));
        });
        return;
      }

      const responseId = responseIdFromEvent(asRecord(event) ?? {});
      if (responseId) {
        latestResponseId = responseId;
      }

      if (eventType === "response.output_text.delta") {
        const delta = asRecord(event)?.delta;
        if (typeof delta === "string") {
          currentResponseText += delta;
          if (debugEvents) process.stderr.write(delta);
        }
      }

      if (eventType === "response.output_text.done" && debugEvents) {
        process.stderr.write("\n");
      }

      if (eventType === "response.completed") {
        completedCount += 1;
        if (latestResponseId) {
          responseChain.push(latestResponseId);
        }
        if (currentResponseText.trim().length > 0) {
          responseTexts.push(currentResponseText.trim());
        }
        currentResponseText = "";

        if (phase === "warmup") {
          if (!latestResponseId) {
            done(() => {
              closeSocket();
              reject(new Error("missing response id after warmup response.completed"));
            });
            return;
          }

          phase = "generate";
          sendGenerate(latestResponseId);
          return;
        }

        done(() => {
          closeSocket();
          resolve({
            eventType,
            eventTypes,
            sendCount,
            receiveEventCount,
            completedCount,
            responseChain,
            responseTexts,
          });
        });
      }
    });
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      endpoint: "openai.websocket-mode",
      eventType: result.eventType,
      eventTypes: result.eventTypes,
      sendCount: result.sendCount,
      receiveEventCount: result.receiveEventCount,
      completedCount: result.completedCount,
      responseChain: result.responseChain,
      responseTexts: result.responseTexts,
      model,
      timeoutMs,
      proxyEnabled: Boolean(proxyUrl),
    })}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
