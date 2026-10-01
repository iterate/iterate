/**
 * Cloudflare's OTLP export (OTLP/HTTP JSON, from Workers Observability destinations) flattened into
 * rows of the `logs` and `spans` tables; docs/telemetry.md#tables says what each column holds.
 * The payloads are parsed with the fields the rows read, and nothing else is required of them.
 * OTLP JSON (proto3) leaves out a field at its default value, so a time, severity or kind of 0,
 * an empty body, and a resource or a list with nothing in it parse as those. A batch is parsed
 * down to its records (`OtlpLogs`, `OtlpTraces`) and each record on its own: one that does not
 * parse is skipped, and the rest of its batch lands.
 */
import { z } from "zod";

/** OTLP's AnyValue. An int64 is a string in OTLP JSON, and Cloudflare writes a number; a
 *  `console.log`ged null or undefined arrives as `{}`. */
interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  bytesValue?: string;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: { key: string; value: AnyValue }[] };
}
const AnyValue: z.ZodType<AnyValue> = z.lazy(() =>
  z.object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    bytesValue: z.string().optional(),
    arrayValue: z.object({ values: z.array(AnyValue).optional() }).optional(),
    kvlistValue: z.object({ values: Attributes }).optional(),
  }),
);
const Attributes = z.array(z.object({ key: z.string(), value: AnyValue })).optional();
const Resource = z.object({ attributes: Attributes }).default({});
/** Nanoseconds since the epoch: OTLP's fixed64, which its JSON writes in decimal digits. Any 20 of
 *  them is a time a Date holds, so `isoTime` and a span's duration cannot throw. */
const UnixNano = z.string().regex(/^\d{1,20}$/);

/** A batch of logs down to its records, each as it came: `logRows` parses those one by one. */
export const OtlpLogs = z.object({
  resourceLogs: z
    .array(
      z.object({
        resource: Resource,
        scopeLogs: z.array(z.object({ logRecords: z.array(z.unknown()).default([]) })).default([]),
      }),
    )
    .default([]),
});
const LogRecord = z.object({
  timeUnixNano: UnixNano.default("0"),
  severityNumber: z.number().default(0),
  body: AnyValue.default({}),
  attributes: Attributes,
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});

/** A batch of spans down to its spans, each as it came: `spanRows` parses those one by one. */
export const OtlpTraces = z.object({
  resourceSpans: z
    .array(
      z.object({
        resource: Resource,
        scopeSpans: z.array(z.object({ spans: z.array(z.unknown()).default([]) })).default([]),
      }),
    )
    .default([]),
});
const Span = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.number().default(0),
  startTimeUnixNano: UnixNano,
  endTimeUnixNano: UnixNano,
  attributes: Attributes,
  events: z.array(z.object({ name: z.string(), attributes: Attributes })).optional(),
});

/** The most a JSON column's text takes of a row's JSON, escapes included: a row over 1 MB fails
 *  its stream's whole batch, and this with an exception and a stack leaves the other columns
 *  half of that. */
const JSON_COLUMN_MAX_BYTES = 512 * 1024;
/** The most `exception` takes, and `stack`: a column with no `_bytes` beside it. */
const EXCEPTION_COLUMN_MAX_BYTES = 16 * 1024;

/** One row per log record: a `console.*` line, an uncaught exception, and Cloudflare's own record
 *  of each invocation (no `name: "log"`, no exception), whose event is `invocation` and whose body
 *  is everything it says: its message (`GET https://…`, `jsrpc`, an alarm's time) and its
 *  attributes, the URL and its query, the visitor's whereabouts and user agent among them.
 *  `skipped` says why each record that did not parse landed no row. */
export function logRows(payload: z.infer<typeof OtlpLogs>) {
  const skipped: string[] = [];
  const rows = payload.resourceLogs.flatMap(({ resource, scopeLogs }) => {
    const { worker, version } = workerOf(resource.attributes);
    // no Worker's: the destination's preflight
    if (!worker) return [];
    return scopeLogs.flatMap(({ logRecords }) =>
      parsed(LogRecord, logRecords, skipped).map((record) => {
        const attributes = plainAttributes(record.attributes);
        const exception = exceptionOf(attributes);
        const invocation = attributes.name !== "log" && !exception;
        const fields = plainAttributes(record.body.kvlistValue?.values);
        const value = plain(record.body);
        const body = capped(
          invocation
            ? JSON.stringify({ message: value, ...attributes })
            : typeof value === "string"
              ? value
              : JSON.stringify(value),
        );
        const severity = record.severityNumber;
        const stack = text(attributes["exception.stacktrace"]);
        return {
          time: isoTime(record.timeUnixNano),
          worker,
          project_id: text(fields.projectId),
          path: text(fields.path),
          version,
          level:
            severity >= 17 ? "error" : severity >= 13 ? "warn" : severity >= 9 ? "info" : "debug",
          trace_id: record.traceId,
          span_id: record.spanId,
          seq: number(attributes["cloudflare.invocation.sequence.number"]),
          event: invocation ? "invocation" : text(fields.event),
          body: body.text,
          body_bytes: body.bytes,
          exception,
          stack: stack && cut(stack, EXCEPTION_COLUMN_MAX_BYTES),
        };
      }),
    );
  });
  return { rows, skipped };
}

/** One row per span. `attributes` keeps what no column holds, minus what every span of a Worker
 *  repeats (its resource, the scope's name) and what says who asked: the visitor's whereabouts
 *  (`geo.*`, their network's ASN), user agent and headers, and the URL whole or its query, which
 *  can carry a token. `skipped` is as `logRows`'s. */
export function spanRows(payload: z.infer<typeof OtlpTraces>) {
  const skipped: string[] = [];
  const rows = payload.resourceSpans.flatMap(({ resource, scopeSpans }) => {
    const { worker, version } = workerOf(resource.attributes);
    // no Worker's: the destination's preflight
    if (!worker) return [];
    const repeated = new Set(resource.attributes?.map(({ key }) => key));
    return scopeSpans.flatMap(({ spans }) =>
      parsed(Span, spans, skipped).map((span) => {
        const {
          "iterate.project_id": projectId,
          "iterate.path": path,
          "cloudflare.invocation.sequence.number": seq,
          cpu_time_ms: cpuMs,
          wall_time_ms: wallMs,
          "cloudflare.outcome": outcome,
          "cloudflare.entrypoint": entrypoint,
          "cloudflare.durable_object.id": objectId,
          "jsrpc.method": rpcMethod,
          "http.response.status_code": httpStatus,
          "url.path": urlPath,
          ...rest
        } = plainAttributes(span.attributes);
        const thrown = span.events?.find((event) => event.name === "exception");
        const attributes = capped(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(rest).filter(
                ([key]) => !repeated.has(key) && !DROPPED_SPAN_ATTRIBUTE.test(key),
              ),
            ),
          ),
        );
        return {
          time: isoTime(span.startTimeUnixNano),
          worker,
          project_id: text(projectId),
          path: text(path),
          version,
          trace_id: span.traceId,
          span_id: span.spanId,
          parent_span_id: span.parentSpanId || undefined,
          seq: number(seq),
          name: span.name,
          kind: SPAN_KINDS[span.kind] ?? String(span.kind),
          duration_ms: Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6,
          cpu_ms: number(cpuMs),
          wall_ms: number(wallMs),
          outcome: text(outcome),
          entrypoint: text(entrypoint),
          object_id: text(objectId),
          rpc_method: text(rpcMethod),
          http_status: number(httpStatus),
          url_path: text(urlPath),
          exception: thrown && exceptionOf(plainAttributes(thrown.attributes)),
          attributes: attributes.text,
          attributes_bytes: attributes.bytes,
        };
      }),
    );
  });
  return { rows, skipped };
}

const DROPPED_SPAN_ATTRIBUTE =
  /^(scope\.name|geo\..*|cloudflare\.asn|user_agent\.original|http\.(request|response)\.header\..*|url\.full|url\.query)$/;

/** OTLP's SpanKind, by number; one past these is written as its number. */
const SPAN_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];

/** The `records` that parse as `schema`. Why each other one does not, by its first issue, joins
 *  `skipped`. */
function parsed<T>(schema: z.ZodType<T>, records: unknown[], skipped: string[]) {
  return records.flatMap((record) => {
    const result = schema.safeParse(record);
    if (result.success) return [result.data];
    const issue = result.error.issues[0]!;
    skipped.push(`${issue.path.join(".")}: ${issue.message}`);
    return [];
  });
}

/** The Worker a resource is: its script's name and version; neither for one that is no Worker's. */
function workerOf(attributes: z.infer<typeof Attributes>) {
  const resource = plainAttributes(attributes);
  return {
    worker: text(resource["cloudflare.script_name"]),
    version: text(resource["cloudflare.script_version.id"]),
  };
}

/** `exception.type: exception.message`, when the attributes describe one. */
function exceptionOf(attributes: Record<string, unknown>) {
  const type = text(attributes["exception.type"]);
  return (
    type && cut(`${type}: ${text(attributes["exception.message"])}`, EXCEPTION_COLUMN_MAX_BYTES)
  );
}

function plainAttributes(attributes: z.infer<typeof Attributes>): Record<string, unknown> {
  return Object.fromEntries((attributes || []).map(({ key, value }) => [key, plain(value)]));
}

/** An AnyValue as the JSON value it stands for. It holds one of its keys, whose value may be falsy
 *  (`""`, `false`, `0`), or none for null. */
function plain(value: AnyValue): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("bytesValue" in value) return value.bytesValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(plain);
  if (value.kvlistValue) return plainAttributes(value.kvlistValue.values);
  return null;
}

/** A JSON column's text, cut to JSON_COLUMN_MAX_BYTES, and its whole size in UTF-8 bytes. */
function capped(json: string) {
  return { text: cut(json, JSON_COLUMN_MAX_BYTES), bytes: utf8Bytes(json) };
}

/** `value`, halved until it takes at most `maxBytes` of a row's JSON. A row is sent as JSON, where
 *  a control character is six bytes and a quote two, so the text's own size bounds nothing.
 *  Halving takes a few passes whatever the text holds. A half that ends inside a surrogate pair
 *  ends in U+FFFD: a lone surrogate's escape is JSON a stream may refuse. */
function cut(value: string, maxBytes: number) {
  let kept = value;
  while (utf8Bytes(JSON.stringify(kept)) > maxBytes)
    kept = kept.slice(0, kept.length / 2).toWellFormed();
  return kept;
}

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** OTLP's nanoseconds since the epoch as RFC 3339, to the millisecond. */
const isoTime = (unixNano: string) => new Date(Number(BigInt(unixNano) / 1_000_000n)).toISOString();

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const number = (value: unknown) => (typeof value === "number" ? value : undefined);
