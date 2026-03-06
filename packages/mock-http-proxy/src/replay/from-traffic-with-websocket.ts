import { fromTraffic } from "@mswjs/source/traffic";
import type { Entry as HarEntry, Har } from "har-format";
import { ws, type RequestHandler, type WebSocketHandler } from "msw";
import type {
  HarEntryWithExtensions,
  HarWebSocketMessage,
  HarWithExtensions,
} from "../har/har-extensions.ts";

export type TrafficReplayHandler = RequestHandler | WebSocketHandler;

export type FromTrafficWithWebSocketOptions = {
  /**
   * `path` is resilient when URL host/protocol are rewritten by upstream proxies.
   * `url` replays against the absolute websocket URL in HAR.
   */
  matchWebSocketBy?: "path" | "url";
  /**
   * When true, validate each websocket "send" frame payload/opcode exactly.
   * When false, consume one recorded send frame per inbound message.
   */
  strictSendMatch?: boolean;
};

type WebSocketSession = {
  matchUrl: string;
  messages: HarWebSocketMessage[];
  startedDateTime: string;
};

function toHttpArchive(archive: HarWithExtensions): Har {
  return {
    ...archive,
    log: {
      ...archive.log,
      entries: archive.log.entries.filter((entry) => {
        const url = entry.request.url;
        return (
          (url.startsWith("http://") || url.startsWith("https://")) && entry.response.status !== 101
        );
      }) as HarEntry[],
    },
  };
}

function normalizeIncomingWebSocketData(data: unknown): { opcode: number; data: string } | null {
  if (typeof data === "string") {
    return { opcode: 1, data };
  }
  if (Buffer.isBuffer(data)) {
    return { opcode: 2, data: data.toString("base64") };
  }
  if (data instanceof ArrayBuffer) {
    return { opcode: 2, data: Buffer.from(data).toString("base64") };
  }
  if (ArrayBuffer.isView(data)) {
    return {
      opcode: 2,
      data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
    };
  }
  return null;
}

function replayWebSocketPayload(message: HarWebSocketMessage): string | Buffer {
  if (message.opcode === 2) {
    return Buffer.from(message.data, "base64");
  }
  return message.data;
}

function websocketMatchUrl(entry: HarEntryWithExtensions, mode: "path" | "url"): string {
  const parsed = new URL(entry.request.url);
  if (mode === "url") return parsed.toString();
  return `${parsed.pathname}${parsed.search}`;
}

function collectWebSocketSessions(
  archive: HarWithExtensions,
  options: FromTrafficWithWebSocketOptions,
): Map<string, WebSocketSession[]> {
  const mode = options.matchWebSocketBy ?? "path";
  const grouped = new Map<string, WebSocketSession[]>();

  for (const entry of archive.log.entries) {
    if (!Array.isArray(entry._webSocketMessages)) continue;
    const matchUrl = websocketMatchUrl(entry, mode);
    const sessions = grouped.get(matchUrl) ?? [];
    sessions.push({
      matchUrl,
      messages: entry._webSocketMessages,
      startedDateTime: entry.startedDateTime,
    });
    grouped.set(matchUrl, sessions);
  }

  for (const sessions of grouped.values()) {
    sessions.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
  }

  return grouped;
}

function createWebSocketHandler(
  matchUrl: string,
  sessions: WebSocketSession[],
  options: FromTrafficWithWebSocketOptions,
): WebSocketHandler {
  const socket = ws.link(matchUrl);
  const strict = options.strictSendMatch ?? false;
  let nextSessionIndex = 0;

  return socket.addEventListener("connection", ({ client }) => {
    const session = sessions[nextSessionIndex];
    if (!session) {
      client.close(1013, "No HAR websocket sessions left");
      return;
    }
    nextSessionIndex += 1;

    const messages = session.messages;
    let cursor = 0;

    const sendRecordedReceives = () => {
      while (cursor < messages.length && messages[cursor]?.type === "receive") {
        const current = messages[cursor]!;
        cursor += 1;
        client.send(replayWebSocketPayload(current));
      }

      if (cursor >= messages.length) {
        client.close(1000, "HAR websocket replay complete");
      }
    };

    sendRecordedReceives();

    client.addEventListener("message", (event) => {
      const expected = messages[cursor];
      if (!expected || expected.type !== "send") {
        if (strict) {
          client.close(1008, "unexpected websocket client message");
        }
        return;
      }

      if (strict) {
        const actual = normalizeIncomingWebSocketData(event.data);
        if (!actual || actual.opcode !== expected.opcode || actual.data !== expected.data) {
          client.close(1008, "websocket frame mismatch");
          return;
        }
      }

      cursor += 1;
      sendRecordedReceives();
    });
  });
}

export function fromTrafficWithWebSocket(
  archive: HarWithExtensions,
  options: FromTrafficWithWebSocketOptions = {},
): TrafficReplayHandler[] {
  const httpHandlers = fromTraffic(toHttpArchive(archive));
  const wsSessions = collectWebSocketSessions(archive, options);
  const wsHandlers = Array.from(wsSessions.entries()).map(([matchUrl, sessions]) =>
    createWebSocketHandler(matchUrl, sessions, options),
  );
  return [...httpHandlers, ...wsHandlers];
}
