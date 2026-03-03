import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket } from "ws";

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

function userMessage(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  ];
}

async function main() {
  const apiKey = required("OPENAI_API_KEY");
  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-5.2";
  const timeoutMs = parseTimeoutMs(process.env.OPENAI_REALTIME_TIMEOUT_MS, 4_000);

  const proxyUrl = getProxyUrl();
  const socket = new WebSocket("wss://api.openai.com/v1/responses", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
  });

  const closeSocket = () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    socket.terminate();
  };

  const result = await new Promise<{
    eventType: string;
    eventTypes: string[];
    sendCount: number;
    receiveEventCount: number;
    completedCount: number;
    responseChain: string[];
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      done(() => {
        closeSocket();
        reject(new Error(`timed out waiting for websocket events after ${String(timeoutMs)}ms`));
      });
    }, timeoutMs);

    const eventTypes: string[] = [];
    const responseChain: string[] = [];
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

    const sendWarmup = () => {
      socket.send(
        JSON.stringify({
          type: "response.create",
          model,
          store: false,
          generate: false,
          input: userMessage("Ping."),
          tools: [],
        }),
      );
      sendCount += 1;
    };

    const sendGenerate = (previousResponseId: string) => {
      socket.send(
        JSON.stringify({
          type: "response.create",
          model,
          store: false,
          previous_response_id: previousResponseId,
          input: userMessage("Reply with exactly OK."),
          max_output_tokens: 8,
          tools: [],
        }),
      );
      sendCount += 1;
    };

    socket.on("open", () => {
      sendWarmup();
    });

    socket.on("error", (error) => {
      done(() => {
        closeSocket();
        reject(error);
      });
    });

    socket.on("message", (raw) => {
      receiveEventCount += 1;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch (error) {
        done(() => {
          closeSocket();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      const eventType = event.type;
      if (typeof eventType !== "string") return;
      eventTypes.push(eventType);

      const responseId = responseIdFromEvent(event);
      if (responseId) {
        latestResponseId = responseId;
      }

      if (eventType === "response.completed") {
        completedCount += 1;
        if (latestResponseId) {
          responseChain.push(latestResponseId);
        }

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
