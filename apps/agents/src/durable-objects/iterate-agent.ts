import { Agent, type Connection, type WSMessage } from "agents";

const RECEIVED_EVENTS_KEY = "receivedEvents";

export class IterateAgent extends Agent {
  onMessage(_connection: Connection, message: WSMessage) {
    const receivedEvents = this.ctx.storage.kv.get<string[]>(RECEIVED_EVENTS_KEY) ?? [];
    receivedEvents.push(coerceMessageToString(message));
    this.ctx.storage.kv.put(RECEIVED_EVENTS_KEY, receivedEvents);
  }

  onRequest(request: Request) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET",
        },
      });
    }

    const receivedEvents = this.ctx.storage.kv.get<string[]>(RECEIVED_EVENTS_KEY) ?? [];
    return Response.json(receivedEvents);
  }
}

function coerceMessageToString(message: WSMessage) {
  if (typeof message === "string") {
    return message;
  }

  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }

  if (ArrayBuffer.isView(message)) {
    return new TextDecoder().decode(message);
  }

  return String(message);
}
