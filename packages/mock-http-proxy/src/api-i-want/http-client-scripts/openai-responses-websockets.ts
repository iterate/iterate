import OpenAI from "openai";
import { OpenAIRealtimeWebSocket } from "openai/realtime/websocket";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const apiKey = required("OPENAI_API_KEY");
  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";

  const client = new OpenAI({ apiKey });
  const socket = await OpenAIRealtimeWebSocket.create(client, { model });

  const result = await new Promise<{ eventType: string | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      done(() => {
        socket.close();
        resolve({ eventType: null });
      });
    }, 15_000);

    let finished = false;
    const done = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      fn();
    };

    socket.on("error", (error) => {
      done(() => reject(error));
    });

    socket.on("event", (event) => {
      done(() => {
        socket.close();
        resolve({ eventType: event.type });
      });
    });

    const sendRequest = () => {
      socket.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "Say ok",
        },
      });
    };

    if (socket.socket.readyState === 1) {
      sendRequest();
    } else {
      socket.socket.addEventListener("open", sendRequest, { once: true });
    }
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      endpoint: "openai.websocket-mode",
      eventType: result.eventType,
      model,
    })}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
