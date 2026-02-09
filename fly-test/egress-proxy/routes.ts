import {
  closeUpstream,
  isBlockedHost,
  isTextLike,
  json,
  nextRequestId,
  normalizeKnownWsMessage,
  normalizeUnknownWsMessage,
  parseWsTarget,
  payloadSummary,
  rewriteU2c,
  sanitizeInboundHeaders,
  sanitizeOutboundHeaders,
} from "./utils.ts";
import type { Logger, ProxySocketData } from "./utils.ts";

export type WsDefaults = {
  target: string;
};

export type TransformConfig = {
  proofPrefix: string;
  transformTimeoutMs: number;
};

type WsParams = {
  target: URL | null;
};

const WS_DROP_WORDS = ["offending", "dropme"];
const WS_HOLD_WORDS = ["reviewme"];
const WS_HOLD_MS = 30_000;
const WS_REWRITE_FROM = "server-secret";
const WS_REWRITE_TO = "server-public";
const HTTP_HOLD_HOST = "example.com";
const HTTP_HOLD_QUERY_KEY = "review";
const HTTP_HOLD_QUERY_VALUE = "1";
const HTTP_HOLD_MS = 4_000;

function withRequestId(requestId: string, message: string): string {
  return `<${requestId}> ${message}`;
}

function readTailLineCount(url: URL): number {
  const requested = Number(url.searchParams.get("lines") ?? "300");
  if (!Number.isFinite(requested)) return 300;
  return Math.max(1, Math.min(1000, requested));
}

function getWsParams(url: URL, wsDefaults: WsDefaults): WsParams {
  const targetParam = (url.searchParams.get("target") ?? wsDefaults.target).trim();
  return {
    target: parseWsTarget(targetParam),
  };
}

function firstMatchingWord(text: string, words: string[]): string | null {
  const value = text.toLowerCase();
  for (const word of words) {
    if (value.includes(word.toLowerCase())) return word;
  }
  return null;
}

function shouldHoldHttpRequest(target: URL): boolean {
  const hostname = target.hostname.toLowerCase();
  if (hostname !== HTTP_HOLD_HOST && !hostname.endsWith(`.${HTTP_HOLD_HOST}`)) return false;
  return target.searchParams.get(HTTP_HOLD_QUERY_KEY) === HTTP_HOLD_QUERY_VALUE;
}

export function handleHome(indexHtml: Bun.BunFile): Response {
  return new Response(indexHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function handleHealthz(): Response {
  return new Response("ok\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function handleTail(url: URL, logger: Logger): Response {
  return new Response(logger.getTail(readTailLineCount(url)), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function handleTransform(
  request: Request,
  target: string,
  requestId: string,
  logger: Logger,
  config: TransformConfig,
): Promise<Response> {
  const method = request.method.toUpperCase();

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "invalid url" }, 400);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ error: "unsupported protocol" }, 400);
  }

  logger.appendLog(withRequestId(requestId, `Received proxied ${method} request for ${target}.`));

  if (isBlockedHost(parsed.hostname)) {
    logger.appendLog(
      withRequestId(
        requestId,
        `Blocked by policy before upstream call. Host "${parsed.hostname}" is not allowed.`,
      ),
    );
    return new Response("policy violation\n", {
      status: 451,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (shouldHoldHttpRequest(parsed)) {
    logger.appendLog(
      withRequestId(
        requestId,
        `Holding HTTP request for ${HTTP_HOLD_MS}ms to simulate human-in-the-loop review (matched ${HTTP_HOLD_HOST}?${HTTP_HOLD_QUERY_KEY}=${HTTP_HOLD_QUERY_VALUE}).`,
      ),
    );
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), HTTP_HOLD_MS);
    });
    logger.appendLog(
      withRequestId(
        requestId,
        `HTTP review wait complete after ${HTTP_HOLD_MS}ms. Sending request to upstream now.`,
      ),
    );
  }

  const init: RequestInit = {
    method,
    headers: sanitizeInboundHeaders(request.headers),
    redirect: "manual",
    signal: AbortSignal.timeout(
      Number.isFinite(config.transformTimeoutMs) ? config.transformTimeoutMs : 5000,
    ),
  };
  if (method !== "GET" && method !== "HEAD") init.body = request.body;

  const startedAt = Date.now();
  try {
    const upstream = await fetch(target, init);
    const contentType = upstream.headers.get("content-type") ?? "";
    const headers = sanitizeOutboundHeaders(upstream.headers);

    let bodyOut: BodyInit | null = upstream.body;
    let transformedText = false;
    if (method === "HEAD") {
      bodyOut = null;
    } else if (isTextLike(contentType)) {
      bodyOut = `${config.proofPrefix}${await upstream.text()}`;
      transformedText = true;
    }

    logger.appendLog(
      withRequestId(
        requestId,
        `Upstream response ${upstream.status} in ${Date.now() - startedAt}ms. ${transformedText ? 'Prepended "I was inserted by the egress proxy lol" to text response body.' : "Forwarded response body without text change."}`,
      ),
    );

    return new Response(bodyOut, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.appendLog(
      withRequestId(
        requestId,
        `Upstream request failed after ${Date.now() - startedAt}ms: ${message}`,
      ),
    );
    return json({ error: message }, 502);
  }
}

export function handleWsUpgrade(
  request: Request,
  server: Bun.Server<ProxySocketData>,
  url: URL,
  logger: Logger,
  wsDefaults: WsDefaults,
): Response | undefined {
  const wsParams = getWsParams(url, wsDefaults);
  if (wsParams.target === null) {
    return json({ error: "invalid ws target (use ws:// or wss://)" }, 400);
  }

  if (isBlockedHost(wsParams.target.hostname)) {
    const requestId = nextRequestId("ws");
    logger.appendLog(
      withRequestId(requestId, `Blocked websocket target by policy: ${wsParams.target.toString()}`),
    );
    return new Response("policy violation\n", {
      status: 451,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const requestId = nextRequestId("ws");
  if (
    server.upgrade(request, {
      data: {
        requestId,
        target: wsParams.target.toString(),
        upstream: null,
        holdTimers: new Set(),
      },
    })
  ) {
    return;
  }

  return new Response("websocket upgrade failed\n", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function connectUpstream(ws: Bun.ServerWebSocket<ProxySocketData>, logger: Logger): void {
  const data = ws.data;
  logger.appendLog(
    withRequestId(data.requestId, `Connecting to upstream websocket server ${data.target}.`),
  );

  const upstream = new WebSocket(data.target);
  data.upstream = upstream;

  upstream.onopen = () => {
    logger.appendLog(
      withRequestId(data.requestId, `Upstream websocket connection is open (${data.target}).`),
    );
  };

  upstream.onerror = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.appendLog(withRequestId(data.requestId, `Upstream websocket error: ${message}`));
  };

  upstream.onclose = (event) => {
    logger.appendLog(
      withRequestId(
        data.requestId,
        `Upstream websocket closed (code=${event.code}, reason="${event.reason || ""}").`,
      ),
    );
    data.upstream = null;
  };

  upstream.onmessage = (event) => {
    void (async () => {
      const payload = await normalizeUnknownWsMessage(event.data);
      const rewritten = rewriteU2c(payload, WS_REWRITE_FROM, WS_REWRITE_TO);
      if (rewritten.payload !== payload.payload) {
        logger.appendLog(
          withRequestId(
            data.requestId,
            `Rewrote upstream message before sending to sandbox (replace "${WS_REWRITE_FROM}" -> "${WS_REWRITE_TO}"). before=${payloadSummary(payload)} after=${payloadSummary(rewritten)}`,
          ),
        );
      }

      logger.appendLog(
        withRequestId(
          data.requestId,
          `Sending upstream message to sandbox client: ${payloadSummary(rewritten)}`,
        ),
      );
      try {
        ws.send(rewritten.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.appendLog(
          withRequestId(data.requestId, `Failed sending message to sandbox client: ${message}`),
        );
      }
    })();
  };
}

export function handleWsOpen(ws: Bun.ServerWebSocket<ProxySocketData>, logger: Logger): void {
  const data = ws.data;
  logger.appendLog(
    withRequestId(
      data.requestId,
      `Sandbox websocket client connected. Policy: drop words [${WS_DROP_WORDS.join(", ")}]; hold words [${WS_HOLD_WORDS.join(", ")}] for ${WS_HOLD_MS}ms; rewrite upstream "${WS_REWRITE_FROM}" -> "${WS_REWRITE_TO}".`,
    ),
  );
  connectUpstream(ws, logger);
}

export function handleWsMessage(
  ws: Bun.ServerWebSocket<ProxySocketData>,
  message: string | Buffer | Uint8Array,
  logger: Logger,
): void {
  const data = ws.data;
  const payload = normalizeKnownWsMessage(message);
  const payloadText = payload.text ?? "";

  const dropWord = payload.text === null ? null : firstMatchingWord(payloadText, WS_DROP_WORDS);
  if (dropWord !== null) {
    logger.appendLog(
      withRequestId(
        data.requestId,
        `Dropping client message because it matched blocked word "${dropWord}": ${payloadSummary(payload)}`,
      ),
    );
    return;
  }

  const holdWord = payload.text === null ? null : firstMatchingWord(payloadText, WS_HOLD_WORDS);
  if (holdWord !== null) {
    logger.appendLog(
      withRequestId(
        data.requestId,
        `Holding client message for ${WS_HOLD_MS}ms to simulate human-in-the-loop review (matched "${holdWord}"): ${payloadSummary(payload)}`,
      ),
    );
    const timer = setTimeout(() => {
      data.holdTimers.delete(timer);
      if (data.upstream === null || data.upstream.readyState !== WebSocket.OPEN) {
        logger.appendLog(
          withRequestId(
            data.requestId,
            "Review wait finished but upstream websocket is not open; cannot forward held message.",
          ),
        );
        return;
      }
      try {
        data.upstream.send(payload.payload);
        logger.appendLog(
          withRequestId(
            data.requestId,
            `Review wait complete after ${WS_HOLD_MS}ms. Sending held message onwards to upstream websocket server: ${payloadSummary(payload)}`,
          ),
        );
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        logger.appendLog(
          withRequestId(data.requestId, `Failed to send held message after review wait: ${err}`),
        );
      }
    }, WS_HOLD_MS);
    data.holdTimers.add(timer);
    return;
  }

  logger.appendLog(
    withRequestId(
      data.requestId,
      `Forwarding client message to upstream websocket server: ${payloadSummary(payload)}`,
    ),
  );
  if (data.upstream === null || data.upstream.readyState !== WebSocket.OPEN) {
    logger.appendLog(
      withRequestId(
        data.requestId,
        "Skipped forwarding because upstream websocket is not open yet.",
      ),
    );
    return;
  }

  try {
    data.upstream.send(payload.payload);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logger.appendLog(
      withRequestId(
        data.requestId,
        `Failed sending client message to upstream websocket server: ${err}`,
      ),
    );
  }
}

export function handleWsClose(
  ws: Bun.ServerWebSocket<ProxySocketData>,
  code: number,
  reason: string,
  logger: Logger,
): void {
  const data = ws.data;
  logger.appendLog(
    withRequestId(
      data.requestId,
      `Sandbox websocket client closed (code=${code}, reason="${reason || ""}").`,
    ),
  );
  for (const timer of data.holdTimers) {
    clearTimeout(timer);
  }
  data.holdTimers.clear();
  closeUpstream(data);
}
