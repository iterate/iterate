import {
  closeUpstream,
  isTextLike,
  json,
  nextRequestId,
  normalizeKnownWsMessage,
  normalizeUnknownWsMessage,
  parseWsTarget,
  payloadSummary,
  sanitizeInboundHeaders,
  sanitizeOutboundHeaders,
} from "./utils.ts";
import type { Logger, ProxySocketData, WsPayload } from "./utils.ts";
import type { SecretStore } from "./secrets.ts";
import { needsMagicStringScan } from "./secrets.ts";
import type { PolicyStore } from "./policies.ts";
import { buildHttpContext, buildWsContext, matchesEgressRule } from "./policies.ts";
import type { ApprovalCoordinator } from "./approval.ts";
import type { EventBus } from "./events.ts";
import type { CostTracker } from "./cost-tracker.ts";

export type WsDefaults = {
  target: string;
};

export type TransformConfig = {
  proofPrefix: string;
  transformTimeoutMs: number;
};

export type RouteDeps = {
  secrets: SecretStore;
  policies: PolicyStore;
  approvals: ApprovalCoordinator;
  events: EventBus;
  costs: CostTracker;
};

type WsParams = {
  target: URL | null;
};

const textEncoder = new TextEncoder();

const MAX_BUFFERED_REQUEST_BODY_BYTES = Number(
  process.env.EGRESS_MAX_REQUEST_BODY_BYTES ?? "1048576",
);
const MAX_BUFFERED_RESPONSE_TEXT_BYTES = Number(
  process.env.EGRESS_MAX_RESPONSE_TEXT_BYTES ?? "2097152",
);

let approvalCounter = 0;
function nextApprovalId(): string {
  approvalCounter += 1;
  return `ega-${Date.now()}-${String(approvalCounter).padStart(4, "0")}`;
}

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

function createSSECostTrackingStream(
  upstreamBody: ReadableStream<Uint8Array>,
  requestId: string,
  processedTarget: string,
  logger: Logger,
  deps: RouteDeps,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let trackedStreamingCost = false;

  function processDecodedText(text: string): void {
    if (text.length === 0) return;
    lineBuffer += text;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      if (trackedStreamingCost) continue;

      const costRecord = deps.costs.trackResponse(requestId, processedTarget, payload);
      if (!costRecord) continue;

      trackedStreamingCost = true;
      logger.appendLog(
        withRequestId(
          requestId,
          `COST_STREAM model=${costRecord.model} in=${costRecord.inputTokens} out=${costRecord.outputTokens} cost=$${costRecord.totalCost.toFixed(6)}`,
        ),
      );
      deps.events.broadcast("cost", costRecord);
    }
  }

  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        processDecodedText(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        processDecodedText(decoder.decode());
        if (lineBuffer.trim().startsWith("data:") && !trackedStreamingCost) {
          const payload = lineBuffer.trim().slice(5).trim();
          if (payload.length > 0 && payload !== "[DONE]") {
            const costRecord = deps.costs.trackResponse(requestId, processedTarget, payload);
            if (costRecord) {
              logger.appendLog(
                withRequestId(
                  requestId,
                  `COST_STREAM model=${costRecord.model} in=${costRecord.inputTokens} out=${costRecord.outputTokens} cost=$${costRecord.totalCost.toFixed(6)}`,
                ),
              );
              deps.events.broadcast("cost", costRecord);
            }
          }
        }
      },
    }),
  );
}

async function readBufferedBodyWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "read_error" }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "read_error" };
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

// --- Static handlers (unchanged) ---

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

// --- HTTP transform (policy + secrets + approval) ---

export async function handleTransform(
  request: Request,
  target: string,
  requestId: string,
  logger: Logger,
  config: TransformConfig,
  deps: RouteDeps,
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

  const requestBodyLimit = Number.isFinite(MAX_BUFFERED_REQUEST_BODY_BYTES)
    ? MAX_BUFFERED_REQUEST_BODY_BYTES
    : 1048576;
  const responseBodyLimit = Number.isFinite(MAX_BUFFERED_RESPONSE_TEXT_BYTES)
    ? MAX_BUFFERED_RESPONSE_TEXT_BYTES
    : 2097152;

  logger.appendLog(withRequestId(requestId, `Received proxied ${method} request for ${target}.`));
  logger.appendLog(withRequestId(requestId, `MITM_REQUEST method=${method} target=${target}`));

  // --- 1. Policy check ---
  const headers = sanitizeInboundHeaders(request.headers);

  // Buffer body: read as bytes first to preserve binary payloads
  let bodyBytes: ArrayBuffer | null = null;
  let bodyText: string | undefined;
  let skipBodyInspection = false;
  if (method !== "GET" && method !== "HEAD") {
    const contentLengthHeader = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLengthHeader) && contentLengthHeader > requestBodyLimit) {
      logger.appendLog(
        withRequestId(
          requestId,
          `REQUEST_BODY_SKIP_INSPECTION content_length=${contentLengthHeader} limit=${requestBodyLimit}`,
        ),
      );
      skipBodyInspection = true;
    }
    if (!skipBodyInspection) {
      const inspectionRequest = request.clone();
      if (inspectionRequest.body) {
        const buffered = await readBufferedBodyWithLimit(inspectionRequest.body, requestBodyLimit);
        if (!buffered.ok) {
          if (buffered.reason === "too_large") {
            logger.appendLog(
              withRequestId(
                requestId,
                `REQUEST_BODY_SKIP_INSPECTION stream limit=${requestBodyLimit}`,
              ),
            );
            skipBodyInspection = true;
          } else {
            logger.appendLog(withRequestId(requestId, "REQUEST_BODY_READ_ERROR skip inspection"));
            skipBodyInspection = true;
          }
        } else {
          bodyBytes = buffered.bytes.buffer.slice(
            buffered.bytes.byteOffset,
            buffered.bytes.byteOffset + buffered.bytes.byteLength,
          );
        }
      }
    }

    // Only decode to text if content type is text-like (for magic string scanning + policy checks)
    const reqContentType = request.headers.get("content-type") ?? "";
    if (
      !skipBodyInspection &&
      bodyBytes &&
      bodyBytes.byteLength > 0 &&
      isTextLike(reqContentType)
    ) {
      bodyText = new TextDecoder().decode(bodyBytes);
    }
  }

  const policyContext = buildHttpContext(target, method, headers, bodyText);
  const policyResult = await deps.policies.check(policyContext, "http");

  if (policyResult.decision === "deny" || policyResult.decision === "drop") {
    logger.appendLog(
      withRequestId(
        requestId,
        `Blocked by policy. decision=${policyResult.decision} reason="${policyResult.reason ?? ""}"`,
      ),
    );
    logger.appendLog(withRequestId(requestId, `POLICY_BLOCK host=${parsed.hostname}`));
    return new Response("policy violation\n", {
      status: 451,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // --- 2. Human approval ---
  if (policyResult.decision === "human_approval") {
    const approvalId = nextApprovalId();
    logger.appendLog(
      withRequestId(
        requestId,
        `Holding HTTP request for human approval. id=${approvalId} reason="${policyResult.reason ?? ""}"`,
      ),
    );

    deps.events.broadcast("approval:pending", {
      id: approvalId,
      method,
      url: target,
      reason: policyResult.reason,
      scope: "http",
    });

    const decision = await deps.approvals.waitForDecision({
      id: approvalId,
      createdAt: Date.now(),
      method,
      url: target,
      reason: policyResult.reason,
      scope: "http",
      summary: `${method} ${target}`,
    });

    deps.events.broadcast("approval:decided", { id: approvalId, decision });

    logger.appendLog(
      withRequestId(requestId, `Human approval decision=${decision} id=${approvalId}`),
    );

    if (decision !== "approved") {
      return json(
        {
          error: decision === "timeout" ? "Approval timed out" : "Request rejected by operator",
          approvalId,
          status: decision,
        },
        decision === "timeout" ? 408 : 403,
      );
    }
  }

  // --- 3. Secret injection ---
  let processedTarget = target;
  const processedHeaders = new Headers(headers);

  // Scan URL for magic strings
  if (needsMagicStringScan(target)) {
    const result = await deps.secrets.replaceMagicStrings(target, {}, matchesEgressRule, target);
    if (!result.ok) {
      logger.appendLog(withRequestId(requestId, `SECRET_ERROR url: ${result.error}`));
      return json({ error: result.error }, 424);
    }
    if (result.result !== target) {
      processedTarget = result.result;
      logger.appendLog(
        withRequestId(requestId, `SECRET_INJECT url (${result.usedSecrets.join(", ")})`),
      );
    }
  }

  // Scan headers for magic strings
  for (const [key, value] of processedHeaders.entries()) {
    if (needsMagicStringScan(value)) {
      const result = await deps.secrets.replaceMagicStrings(
        value,
        {},
        matchesEgressRule,
        processedTarget,
      );
      if (!result.ok) {
        logger.appendLog(withRequestId(requestId, `SECRET_ERROR header ${key}: ${result.error}`));
        return json({ error: result.error }, 424);
      }
      if (result.result !== value) {
        processedHeaders.set(key, result.result);
        logger.appendLog(
          withRequestId(
            requestId,
            `SECRET_INJECT header=${key} (${result.usedSecrets.join(", ")})`,
          ),
        );
      }
    }
  }

  // Scan body for magic strings (text only; binary passes through untouched)
  let processedBody: BodyInit | null = null;
  if (method !== "GET" && method !== "HEAD") {
    if (bodyText !== undefined && needsMagicStringScan(bodyText)) {
      const result = await deps.secrets.replaceMagicStrings(
        bodyText,
        {},
        matchesEgressRule,
        processedTarget,
      );
      if (!result.ok) {
        logger.appendLog(withRequestId(requestId, `SECRET_ERROR body: ${result.error}`));
        return json({ error: result.error }, 424);
      }
      processedBody = result.result;
      if (result.usedSecrets.length > 0) {
        logger.appendLog(
          withRequestId(requestId, `SECRET_INJECT body (${result.usedSecrets.join(", ")})`),
        );
      }
    } else if (bodyText !== undefined) {
      // Text body, no magic strings — forward as string
      processedBody = bodyText;
    } else if (bodyBytes !== null) {
      // Binary body — forward raw bytes
      processedBody = bodyBytes;
    } else if (request.body !== null) {
      // Body was not inspected (or not text), stream through without body mutation.
      processedBody = request.body;
    }
  }

  // --- 4. Forward to upstream ---
  const init: RequestInit = {
    method,
    headers: processedHeaders,
    redirect: "manual",
    signal: AbortSignal.timeout(
      Number.isFinite(config.transformTimeoutMs) ? config.transformTimeoutMs : 5000,
    ),
  };
  if (processedBody !== null) init.body = processedBody;

  const startedAt = Date.now();
  try {
    let upstream = await fetch(processedTarget, init);

    // --- 5. 401 retry with refreshed secrets ---
    const canReplayBody = !(processedBody instanceof ReadableStream);
    if (upstream.status === 401 && canReplayBody) {
      logger.appendLog(
        withRequestId(requestId, `Upstream returned 401, retrying with refreshed secrets.`),
      );

      // Re-scan target and headers with fresh lookups
      let retryTarget = target;
      if (needsMagicStringScan(target)) {
        const result = await deps.secrets.replaceMagicStrings(
          target,
          {},
          matchesEgressRule,
          target,
        );
        if (result.ok) retryTarget = result.result;
      }

      const retryHeaders = new Headers(sanitizeInboundHeaders(request.headers));
      for (const [key, value] of retryHeaders.entries()) {
        if (needsMagicStringScan(value)) {
          const result = await deps.secrets.replaceMagicStrings(
            value,
            {},
            matchesEgressRule,
            retryTarget,
          );
          if (result.ok) retryHeaders.set(key, result.result);
        }
      }

      const retryInit: RequestInit = {
        method,
        headers: retryHeaders,
        redirect: "manual",
        signal: AbortSignal.timeout(
          Number.isFinite(config.transformTimeoutMs) ? config.transformTimeoutMs : 5000,
        ),
      };
      if (processedBody !== null) retryInit.body = processedBody;

      upstream = await fetch(retryTarget, retryInit);
      logger.appendLog(
        withRequestId(
          requestId,
          `Retry response ${upstream.status} in ${Date.now() - startedAt}ms.`,
        ),
      );
    } else if (upstream.status === 401 && !canReplayBody) {
      logger.appendLog(
        withRequestId(
          requestId,
          "Skipped 401 retry because request body is streaming/non-replayable.",
        ),
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const outHeaders = sanitizeOutboundHeaders(upstream.headers);
    const isSSE = contentType.toLowerCase().includes("text/event-stream");
    const isMeteredUrl = deps.costs.isMeteredUrl(processedTarget);

    let bodyOut: BodyInit | null = upstream.body;
    let transformedText = false;
    if (method === "HEAD") {
      bodyOut = null;
    } else if (isSSE) {
      if (upstream.body) {
        bodyOut = createSSECostTrackingStream(
          upstream.body,
          requestId,
          processedTarget,
          logger,
          deps,
        );
        outHeaders.delete("content-length");
      } else {
        bodyOut = textEncoder.encode("");
      }
      logger.appendLog(
        withRequestId(
          requestId,
          "Streaming SSE response with inline cost tracking (no transform).",
        ),
      );
    } else if (isTextLike(contentType)) {
      if (isMeteredUrl) {
        const rawText = await upstream.text();

        // Track AI API usage/cost from response body
        const costRecord = deps.costs.trackResponse(requestId, processedTarget, rawText);
        if (costRecord) {
          logger.appendLog(
            withRequestId(
              requestId,
              `COST model=${costRecord.model} in=${costRecord.inputTokens} out=${costRecord.outputTokens} cost=$${costRecord.totalCost.toFixed(6)}`,
            ),
          );
          deps.events.broadcast("cost", costRecord);
        }

        // TODO(nick): Remove this response mutation once demo/proof mode is retired.
        bodyOut = `${config.proofPrefix}${rawText}`;
        transformedText = true;
      } else if (!upstream.body) {
        bodyOut = "";
      } else {
        const upstreamLength = Number(upstream.headers.get("content-length") ?? "0");
        if (Number.isFinite(upstreamLength) && upstreamLength > responseBodyLimit) {
          logger.appendLog(
            withRequestId(
              requestId,
              `RESPONSE_BODY_SKIP_TRANSFORM content_length=${upstreamLength} limit=${responseBodyLimit}`,
            ),
          );
          bodyOut = upstream.body;
        } else {
          const inspectionResponse = upstream.clone();
          if (!inspectionResponse.body) {
            bodyOut = "";
            logger.appendLog(withRequestId(requestId, "Response body unavailable on clone."));
          } else {
            const buffered = await readBufferedBodyWithLimit(
              inspectionResponse.body,
              responseBodyLimit,
            );
            if (!buffered.ok) {
              if (buffered.reason === "too_large") {
                logger.appendLog(
                  withRequestId(
                    requestId,
                    `RESPONSE_BODY_SKIP_TRANSFORM stream limit=${responseBodyLimit}`,
                  ),
                );
              } else {
                logger.appendLog(
                  withRequestId(requestId, "RESPONSE_BODY_READ_ERROR stream without transform"),
                );
              }
              bodyOut = upstream.body;
            } else {
              const rawText = new TextDecoder().decode(buffered.bytes);

              // TODO(nick): Remove this response mutation once demo/proof mode is retired.
              bodyOut = `${config.proofPrefix}${rawText}`;
              transformedText = true;
            }
          }
        }
      }
    }

    logger.appendLog(
      withRequestId(
        requestId,
        `Upstream response ${upstream.status} in ${Date.now() - startedAt}ms. ${transformedText ? "Prepended proof prefix to text response body." : "Forwarded response body without text change."}`,
      ),
    );
    if (transformedText) {
      logger.appendLog(withRequestId(requestId, `TRANSFORM_OK status=${upstream.status}`));
    }

    return new Response(bodyOut, {
      status: upstream.status,
      headers: outHeaders,
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

// --- WebSocket handlers ---

export function handleWsUpgrade(
  request: Request,
  server: Bun.Server<ProxySocketData>,
  url: URL,
  logger: Logger,
  wsDefaults: WsDefaults,
  deps: RouteDeps,
): Response | undefined {
  const wsParams = getWsParams(url, wsDefaults);
  if (wsParams.target === null) {
    return json({ error: "invalid ws target (use ws:// or wss://)" }, 400);
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

  // u2c: pass through (no policy check, no secret injection)
  upstream.onmessage = (event) => {
    void (async () => {
      const payload = await normalizeUnknownWsMessage(event.data);
      logger.appendLog(
        withRequestId(
          data.requestId,
          `Sending upstream message to sandbox client: ${payloadSummary(payload)}`,
        ),
      );
      try {
        ws.send(payload.payload);
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
    withRequestId(data.requestId, `Sandbox websocket client connected to target ${data.target}.`),
  );
  connectUpstream(ws, logger);
}

/**
 * c2u WS message handler. Flow:
 * 1. Secret injection (replace magic strings)
 * 2. Policy check
 * 3. If drop → swallow. If human_approval → hold + wait. If rewrite → apply.
 * 4. Forward to upstream.
 */
export function handleWsMessage(
  ws: Bun.ServerWebSocket<ProxySocketData>,
  message: string | Buffer | Uint8Array,
  logger: Logger,
  deps: RouteDeps,
): void {
  const data = ws.data;
  let payload = normalizeKnownWsMessage(message);

  void (async () => {
    // --- 1. Secret injection (c2u only) ---
    if (payload.text !== null && needsMagicStringScan(payload.text)) {
      const result = await deps.secrets.replaceMagicStrings(
        payload.text,
        {},
        matchesEgressRule,
        data.target,
      );
      if (!result.ok) {
        logger.appendLog(withRequestId(data.requestId, `SECRET_ERROR ws: ${result.error}`));
        return;
      }
      if (result.result !== payload.text) {
        logger.appendLog(
          withRequestId(
            data.requestId,
            `SECRET_INJECT ws payload (${result.usedSecrets.join(", ")})`,
          ),
        );
        payload = {
          bytes: Buffer.byteLength(result.result, "utf8"),
          text: result.result,
          payload: result.result,
        };
      }
    }

    // --- 2. Policy check ---
    const policyContext = buildWsContext(payload.text, payload.bytes, "c2u", data.target);
    const policyResult = await deps.policies.check(policyContext, "ws");

    if (policyResult.decision === "deny" || policyResult.decision === "drop") {
      logger.appendLog(
        withRequestId(
          data.requestId,
          `Dropping client message by policy. reason="${policyResult.reason ?? ""}" ${payloadSummary(payload)}`,
        ),
      );
      return;
    }

    if (policyResult.decision === "human_approval") {
      const approvalId = nextApprovalId();
      logger.appendLog(
        withRequestId(
          data.requestId,
          `Holding client message for human approval. id=${approvalId} reason="${policyResult.reason ?? ""}" ${payloadSummary(payload)}`,
        ),
      );

      deps.events.broadcast("approval:pending", {
        id: approvalId,
        scope: "ws",
        reason: policyResult.reason,
        summary: `WS c2u: ${payloadSummary(payload)}`,
      });

      const decision = await deps.approvals.waitForDecision({
        id: approvalId,
        createdAt: Date.now(),
        scope: "ws",
        reason: policyResult.reason,
        summary: `WS c2u: ${payloadSummary(payload)}`,
      });

      deps.events.broadcast("approval:decided", { id: approvalId, decision });
      logger.appendLog(
        withRequestId(data.requestId, `WS approval decision=${decision} id=${approvalId}`),
      );

      if (decision !== "approved") {
        logger.appendLog(withRequestId(data.requestId, `WS message ${decision}, not forwarding.`));
        return;
      }
    }

    // --- 3. Rewrite ---
    if (
      policyResult.decision === "rewrite" &&
      policyResult.policy?.rewriteFrom &&
      policyResult.policy?.rewriteTo &&
      payload.text !== null
    ) {
      const before = payload.text;
      const after = before.replaceAll(
        policyResult.policy.rewriteFrom,
        policyResult.policy.rewriteTo,
      );
      if (after !== before) {
        logger.appendLog(
          withRequestId(
            data.requestId,
            `Rewrote client message: "${policyResult.policy.rewriteFrom}" -> "${policyResult.policy.rewriteTo}"`,
          ),
        );
        payload = {
          bytes: Buffer.byteLength(after, "utf8"),
          text: after,
          payload: after,
        };
      }
    }

    // --- 4. Forward ---
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
  })();
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
