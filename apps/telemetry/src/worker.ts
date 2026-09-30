/**
 * apps/telemetry — the OTLP receiver (docs/telemetry.md). Cloudflare's Workers Observability export
 * posts every exporting Worker's logs to /v1/logs and spans to /v1/traces, with the shared secret in
 * `x-telemetry-secret` (set on the destination by scripts/ensure-resources.ts); this Worker flattens
 * them into rows (otlp.ts) and sends those to the `logs` and `spans` streams.
 */
import type { Pipeline } from "cloudflare:pipelines";
import {
  failureKind,
  isPlatformFailureKind,
  logPlatformFailure,
  RETRY_AFTER_MS,
} from "iterate/platform-retry";
import { logRows, OtlpLogs, OtlpTraces, spanRows } from "./otlp.ts";

/** Pipelines takes at most 5 MB a send; this leaves room for the array around the rows. */
const SEND_MAX_BYTES = 4 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || (pathname !== "/v1/logs" && pathname !== "/v1/traces"))
      return new Response(
        "apps/telemetry: Cloudflare's OTLP export posts to /v1/logs and /v1/traces (docs/telemetry.md)\n",
        { status: pathname === "/" ? 200 : 404 },
      );
    // 503, not 401: Cloudflare sends the batch again, so rotating the secret loses nothing.
    if (!secretMatches(request.headers.get("x-telemetry-secret"), env.TELEMETRY_OTLP_SECRET))
      return new Response(null, { status: 503 });
    const body =
      request.headers.get("content-encoding") === "gzip"
        ? request.body?.pipeThrough(new DecompressionStream("gzip"))
        : request.body;
    const payload = await new Response(body).json();
    const { rows, stream } =
      pathname === "/v1/logs"
        ? { rows: logRows(OtlpLogs.parse(payload)), stream: env.LOGS }
        : { rows: spanRows(OtlpTraces.parse(payload)), stream: env.SPANS };
    try {
      for (const chunk of sends(rows)) await stream.send(chunk);
    } catch (error) {
      const kind = failureKind(error);
      if (!isPlatformFailureKind(kind)) throw error;
      logPlatformFailure("telemetry", "send", kind, { pathname, message: String(error) });
      return new Response(null, {
        status: 503,
        headers: { "retry-after": String(RETRY_AFTER_MS[kind] / 1000) },
      });
    }
    return Response.json({});
  },
} satisfies ExportedHandler<{ TELEMETRY_OTLP_SECRET: string; LOGS: Pipeline; SPANS: Pipeline }>;

/** Whether the header carries the secret, compared in time that does not depend on where the two
 *  differ: every byte, no early exit. A loop, not Workers' `crypto.subtle.timingSafeEqual`, which
 *  the DOM lib in tsconfig.app.json types away. */
function secretMatches(given: string | null, secret: string) {
  const encoder = new TextEncoder();
  const [a, b] = [encoder.encode(given || ""), encoder.encode(secret)];
  let difference = a.byteLength ^ b.byteLength;
  for (let i = 0; i < b.byteLength; i++) difference |= (a[i] ?? 0) ^ b[i]!;
  return difference === 0;
}

/** `rows` in sends of at most SEND_MAX_BYTES of JSON. */
function* sends(rows: Record<string, unknown>[]) {
  const encoder = new TextEncoder();
  let chunk: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (chunk.length > 0 && bytes + rowBytes > SEND_MAX_BYTES) {
      yield chunk;
      [chunk, bytes] = [[], 0];
    }
    chunk.push(row);
    bytes += rowBytes;
  }
  if (chunk.length > 0) yield chunk;
}
