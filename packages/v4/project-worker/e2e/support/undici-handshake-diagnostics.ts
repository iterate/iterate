// Failure-only observability for Undici WebSocket upgrades in this E2E lane. This deliberately
// records handshake phases and errors, never request/response headers (which may carry cookies).
import { channel, type ChannelListener } from "node:diagnostics_channel";
import { type WebSocket as UndiciWebSocket } from "undici";

const redact = (value: string): string =>
  value
    .replace(/(authorization|cookie|set-cookie)\s*[:=]\s*[^\s;,]+/gi, "$1=[redacted]")
    .slice(0, 1_500);

/** Includes Error's non-enumerable own fields (notably cause/message/stack) without exposing
 * request headers. Used only inside a failing assertion or failure hook. */
export function undiciErrorSurface(value: unknown): string {
  if (!(value instanceof Error)) return value === undefined ? "undefined" : redact(String(value));
  const fields = Object.getOwnPropertyNames(value)
    .map((name) => `${name}=${redact(String((value as unknown as Record<string, unknown>)[name]))}`)
    .join(";");
  return redact(`${value.constructor.name}{${fields}}`);
}

export type UndiciHandshakeDiagnostics = ReturnType<typeof traceUndiciHandshake>;

/** Track the upgrade lifecycle until `dispose()`. The socket-error channel has no socket identity
 * in Undici, so it is explicitly marked unscoped rather than falsely attributed. */
export function traceUndiciHandshake(url: URL) {
  const httpOrigin = new URL(url);
  httpOrigin.protocol = httpOrigin.protocol === "wss:" ? "https:" : "http:";
  const records: string[] = [];
  let socket: UndiciWebSocket | undefined;
  const record = (entry: string) => {
    if (records.length < 16) records.push(entry);
  };
  const requestMatches = (message: unknown): boolean => {
    const request = (message as { request?: { origin?: unknown; path?: unknown } }).request;
    return request?.origin === httpOrigin.origin && request.path === url.pathname;
  };
  const connectionMatches = (message: unknown): boolean => {
    const params = (message as { connectParams?: { host?: unknown; port?: unknown } })
      .connectParams;
    return (
      params?.host === httpOrigin.host || `${params?.host}:${params?.port}` === httpOrigin.host
    );
  };
  const subscriptions: [string, ChannelListener][] = [
    [
      "undici:request:headers",
      (message) => {
        if (!requestMatches(message)) return;
        const response = (message as { response?: { statusCode?: unknown } }).response;
        record(`request-headers status=${response?.statusCode ?? "?"}`);
      },
    ],
    [
      "undici:request:error",
      (message) => {
        if (!requestMatches(message)) return;
        record(`request-error ${undiciErrorSurface((message as { error?: unknown }).error)}`);
      },
    ],
    [
      "undici:client:beforeConnect",
      (message) => {
        if (connectionMatches(message)) record("client-before-connect");
      },
    ],
    [
      "undici:client:connected",
      (message) => {
        if (connectionMatches(message)) record("client-connected");
      },
    ],
    [
      "undici:client:connectError",
      (message) => {
        if (!connectionMatches(message)) return;
        record(
          `client-connect-error ${undiciErrorSurface((message as { error?: unknown }).error)}`,
        );
      },
    ],
    [
      "undici:websocket:open",
      (message) => {
        if ((message as { websocket?: unknown }).websocket === socket) {
          record("websocket-open");
        }
      },
    ],
    [
      "undici:websocket:close",
      (message) => {
        const event = message as { websocket?: unknown; code?: unknown; reason?: unknown };
        if (event.websocket === socket)
          record(`websocket-close code=${event.code} reason=${redact(String(event.reason))}`);
      },
    ],
    [
      "undici:websocket:socket_error",
      (message) => {
        record(`websocket-socket-error(unscoped) ${undiciErrorSurface(message)}`);
      },
    ],
  ];
  for (const [name, listener] of subscriptions) channel(name).subscribe(listener);
  return {
    setSocket(next: UndiciWebSocket) {
      socket = next;
    },
    detail() {
      return records.join(" | ") || "no-undici-diagnostics";
    },
    observeSocketError(error: unknown) {
      record(`websocket-error ${undiciErrorSurface(error)}`);
    },
    dispose() {
      for (const [name, listener] of subscriptions) channel(name).unsubscribe(listener);
    },
  };
}
