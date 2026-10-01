/**
 * apps/telemetry — the OTLP receiver (docs/telemetry.md). Cloudflare's Workers Observability export
 * posts every exporting Worker's logs to /v1/logs and spans to /v1/traces, with the shared secret in
 * `x-telemetry-secret` (set on the destination by scripts/ensure-resources.ts); this Worker flattens
 * them into rows (otlp.ts) and sends those to the `logs` and `spans` streams.
 *
 * Cloudflare sends a batch again when it is answered 5xx, so 5xx is only for what another delivery
 * can mend: a secret this version does not hold yet, and a send that failed. What the batch's own
 * bytes decide, no delivery changes: a batch that cannot be read is answered 400, and one that can
 * is answered 200 with the records that do not parse skipped. Each is logged, once a batch.
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

/** A stream takes no row over 1 MB, and fails the whole send that carries one. The texts' cuts
 *  (otlp.ts) keep a row far under it unless a field no cut bounds is that big (a span's name). */
const ROW_MAX_BYTES = 1_000_000;

export default {
  async fetch(request: Request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || (pathname !== "/v1/logs" && pathname !== "/v1/traces"))
      return new Response(
        "apps/telemetry: Cloudflare's OTLP export posts to /v1/logs and /v1/traces (docs/telemetry.md)\n",
        { status: pathname === "/" ? 200 : 404 },
      );
    // 503, not 401: Cloudflare sends the batch again, so rotating the secret loses nothing. The
    // line is all that shows of a rotation that left the destination and the Worker apart.
    if (!secretMatches(request.headers.get("x-telemetry-secret"), env.TELEMETRY_OTLP_SECRET)) {
      console.warn({ event: "telemetry.secret-refused", pathname });
      return new Response(null, { status: 503 });
    }
    const body =
      request.headers.get("content-encoding") === "gzip"
        ? request.body?.pipeThrough(new DecompressionStream("gzip"))
        : request.body;
    // From its bytes to its rows a batch meets nothing but itself, so one that fails here (its
    // gzip, its JSON, its shape down to the records) fails the same on every delivery: 400.
    const batch = await new Response(body)
      .json()
      .then((payload) =>
        pathname === "/v1/logs"
          ? logRows(OtlpLogs.parse(payload))
          : spanRows(OtlpTraces.parse(payload)),
      )
      .catch((error: unknown) => {
        const message = String(error).slice(0, 1000);
        console.warn({ event: "telemetry.batch-unreadable", pathname, message });
      });
    if (!batch) return new Response(null, { status: 400 });
    const encoder = new TextEncoder();
    const sized = batch.rows.map((row) => ({
      row,
      bytes: encoder.encode(JSON.stringify(row)).byteLength + 1, // and the comma after it
    }));
    const rows = sized.filter(({ bytes }) => bytes <= ROW_MAX_BYTES);
    const skipped = [
      ...batch.skipped,
      ...(rows.length < sized.length ? ["a row over 1 MB, which no stream takes"] : []),
    ];
    if (skipped.length > 0)
      console.warn({
        event: "telemetry.records-skipped",
        pathname,
        skipped: batch.skipped.length + sized.length - rows.length,
        landed: rows.length,
        first: skipped[0],
      });
    const stream = pathname === "/v1/logs" ? env.LOGS : env.SPANS;
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
} satisfies ExportedHandler<{ TELEMETRY_OTLP_SECRET?: string; LOGS: Pipeline; SPANS: Pipeline }>;

/** Whether the header carries the secret, compared in time that does not depend on where the two
 *  differ: every byte, no early exit. A loop, not Workers' `crypto.subtle.timingSafeEqual`, which
 *  the DOM lib in tsconfig.app.json types away. A Worker deployed without its secret holds none,
 *  which nothing matches: no header would otherwise equal it. */
function secretMatches(given: string | null, secret: string | undefined) {
  const encoder = new TextEncoder();
  const [a, b] = [encoder.encode(given || ""), encoder.encode(secret || "")];
  let difference = a.byteLength ^ b.byteLength;
  for (let i = 0; i < b.byteLength; i++) difference |= (a[i] ?? 0) ^ b[i]!;
  return b.byteLength > 0 && difference === 0;
}

/** `rows` in sends of at most SEND_MAX_BYTES of JSON. */
function* sends(rows: { row: Record<string, unknown>; bytes: number }[]) {
  let chunk: Record<string, unknown>[] = [];
  let chunkBytes = 0;
  for (const { row, bytes } of rows) {
    if (chunk.length > 0 && chunkBytes + bytes > SEND_MAX_BYTES) {
      yield chunk;
      [chunk, chunkBytes] = [[], 0];
    }
    chunk.push(row);
    chunkBytes += bytes;
  }
  if (chunk.length > 0) yield chunk;
}
