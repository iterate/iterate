// What actually happened on a voice conversation, as one readable column.
//
//   doppler run --config prd -- pnpm cli voicelab chronology --project voice-test
//   doppler run --config prd -- pnpm cli voicelab chronology --project voice-test --path /agents/voice/2026-08-04-133748
//
// WHY THIS EXISTS. A voice call is two models and a bridge, and until now the
// only way to see what they did to each other was to page through raw events —
// where the interesting six are buried under system prompts, script payloads and
// echoed transcripts, and the ordering between the two halves is the whole
// story. Reading that by hand hid a defect for a full session: an answer the
// thinking half had finished was never spoken, and the transcript alone made it
// look like the model had simply ignored it.
//
// WHAT IS NOT HERE, and cannot be. Audio frames and provider events are appended
// ephemerally — they reach live connections and are never stored — so a stream
// read after the fact holds no `voicelab/grok-event` at all. Everything below is
// the durable record. What the customer said and what the voice said come
// through anyway, because the bridge copies both to the thinking half as
// context, which is persisted.
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab chronology`. */
export interface ChronologyOptions extends VoicelabConnectOptions {
  /** The conversation to read. Defaults to the newest timestamped one. */
  path?: string;
  /** Characters of each payload to show before clipping. */
  width?: number;
  /** Show the setup and system-prompt preamble too. */
  verbose?: boolean;
  /**
   * Only what a person would experience: the two voices, and the two lines the
   * processor put in front of the assistant.
   *
   * The judgement this tool exists for is "does this read like a competent
   * assistant", and that question is answered by the dialogue alone. Scripts,
   * summaries and settlements are how it happened, which is a different
   * question and a much longer column.
   */
  dialogue?: boolean;
}

/**
 * Events that say something happened without saying what, and would otherwise
 * be most of the column: connection churn, token accounting, and the
 * `script-run-started` that always sits between a request and its settlement.
 */
const NOISE = new Set([
  "events.iterate.com/agent/token-usage-reported",
  "events.iterate.com/capability-host/script-run-started",
  "events.iterate.com/stream/connection-closed",
  "events.iterate.com/stream/connection-opened",
  "events.iterate.com/stream/subscription-configured",
]);

/** The four things one row can be about, named for where the words moved. */
type Lane = "→BRAIN" | "BRAIN " | "BRAIN→" | "→VOICE" | "VOICE " | "      ";

interface Row {
  atMs: number;
  lane: Lane;
  line: string;
}

interface StreamEventLike {
  createdAt: string;
  offset: number;
  payload?: unknown;
  type: string;
}

const clip = (value: unknown, width: number): string => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > width ? `${text.slice(0, width)}…` : text;
};

/**
 * One event as one row, or null to drop it.
 *
 * The lane is the point. `→BRAIN` is everything the thinking half was told,
 * `BRAIN` is what it did about it, `BRAIN→` is the moment it said something
 * back, and `→VOICE` is what the bridge actually put into the voice's ear —
 * which is the one column that answers "so why didn't it say that".
 */
function describe(event: StreamEventLike, width: number): Row | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const atMs = Date.parse(event.createdAt);
  const short = event.type.replace("events.iterate.com/", "");
  const row = (lane: Lane, line: string): Row => ({ atMs, lane, line });

  switch (short) {
    case "agents/context-added": {
      const role = String(payload.role ?? "");
      return row("→BRAIN", `[${role}] ${clip(payload.content, width)}`);
    }
    case "agents/web-message-sent":
      return row("BRAIN→", `SENDS: ${clip(payload.message, width)}`);
    case "agent/summary-updated":
      return row("BRAIN ", `summary ${clip(JSON.stringify(payload), 140)}`);
    case "agent/llm-request-requested":
      return row("BRAIN ", `thinking… (${String(payload.model ?? "")})`);
    case "agent/llm-request-settled": {
      const result = (payload.result ?? {}) as Record<string, unknown>;
      const status = String(result.status ?? "");
      /* The text is the script it wrote, which the next two rows already show
       * in full — so this row is only worth its status once it is not ok. */
      return status === "succeeded"
        ? null
        : row("BRAIN ", `thought [${status}] ${clip(result.errorMessage ?? result.reason, width)}`);
    }
    case "capability-host/script-run-requested":
      return row("BRAIN ", `runs: ${clip(payload.code, width)}`);
    case "capability-host/script-run-settled": {
      const settlement = (payload.settlement ?? {}) as Record<string, unknown>;
      const status = String(settlement.status ?? "");
      const detail = settlement.error ?? JSON.stringify(settlement.result ?? null);
      return row("BRAIN ", `  → [${status}] ${clip(detail, width)}`);
    }
    default:
      break;
  }
  if (event.type === "voice-agent/background-activity") {
    return row("→VOICE", `STATUS: ${clip(payload.activity, width)}`);
  }
  if (event.type === "voice-agent/back-office-message") {
    const way = payload.direction === "out" ? "note_to_self" : "RESULT";
    return row("→VOICE", `${way}: ${clip(payload.text, width)}`);
  }
  if (event.type.startsWith("voice-agent/")) {
    const name = event.type.replace("voice-agent/", "");
    return row("VOICE ", `${name} ${clip(JSON.stringify(payload), 120)}`);
  }
  return row("      ", short);
}

/** The newest conversation, when the caller did not name one. */
async function newestConversation(itx: {
  streams: { list(args: { prefix: string }): Promise<unknown> };
}): Promise<string> {
  const listed = (await itx.streams.list({ prefix: "/agents/voice/" })) as Array<
    { path?: string } | string
  > | null;
  const paths = (listed ?? []).map((entry) =>
    typeof entry === "string" ? entry : (entry.path ?? ""),
  );
  /*
   * Timestamped ones only, newest last. Every call mints
   * `/agents/voice/<YYYY-MM-DD-HHMMSS>`, so the name sorts chronologically —
   * while the fixed paths people set up by hand (`device`, `face-check`) would
   * sort after all of them and win a plain "last" every time.
   */
  const stamped = paths.filter((path) => /\/\d{4}-\d{2}-\d{2}-\d{6}$/.test(path)).sort();
  const newest = stamped.at(-1);
  if (newest === undefined) throw new Error("no timestamped conversation on this project");
  /* `streams.list` answers with workspace-qualified paths; `get` wants the
   * project-relative one it was created under. */
  return newest.replace(/^\/workspaces/, "");
}

export async function chronology(options: ChronologyOptions) {
  const width = options.width ?? 200;
  using itx = await connectProject(options);
  const path = options.path ?? (await newestConversation(itx as never));
  const stream = (itx as never as { streams: { get(path: string): StreamReader } }).streams.get(
    path,
  );

  const page = await stream.getEventPage({ limit: 1 });
  const head = page?.streamMaxOffset ?? 0;
  const rows: Row[] = [];
  let offset = 0;
  /* Paged to the platform's ceiling of 500 rather than in one read: a busy
   * call runs to thousands of offsets, and asking for more is an error. */
  while (offset < head) {
    const batch = (await stream.getEvents({ afterOffset: offset, limit: 500 })) ?? [];
    if (batch.length === 0) break;
    let moved = false;
    for (const event of batch) {
      if (event.offset > offset) {
        offset = event.offset;
        moved = true;
      }
      if (NOISE.has(event.type)) continue;
      const row = describe(event, width);
      if (row !== null) rows.push(row);
    }
    if (!moved) break;
  }

  /*
   * Zero is the first row, not the stream's creation: setup and the system
   * prompts happen before anyone speaks, and counting from them puts the whole
   * conversation at "+14s" for no reason.
   */
  /*
   * Zero is when the call was asked for, not when the stream was made. A
   * conversation stream is minted at setup and may be called minutes later, so
   * anchoring on the first row put a whole reading at "+840s" and made every
   * interval in it something you had to subtract by hand.
   */
  const first =
    rows.find((row) => row.line.startsWith("call-requested"))?.atMs ?? rows.at(0)?.atMs ?? 0;
  const dialogue = (row: Row): boolean =>
    row.line.startsWith("[developer] The customer said:") ||
    row.line.startsWith("[developer] You, out loud said:") ||
    row.line.startsWith("STATUS:") ||
    row.line.startsWith("RESULT:");
  const preamble =
    options.dialogue === true
      ? rows.filter(dialogue)
      : options.verbose === true
        ? rows
        : rows.filter((row) => !isSetup(row));
  console.log(`${path} — ${preamble.length} events\n`);
  for (const row of preamble) {
    const at = `${((row.atMs - first) / 1000).toFixed(1).padStart(7)}s`;
    const line =
      options.dialogue === true
        ? row.line
            .replace("[developer] The customer said:", "CUSTOMER :")
            .replace("[developer] You, out loud said:", "ASSISTANT:")
        : row.line;
    console.log(options.dialogue === true ? `${at}  ${line}` : `${at}  ${row.lane}  ${row.line}`);
  }
  if (options.verbose !== true && preamble.length < rows.length) {
    console.log(`\n(${rows.length - preamble.length} setup rows hidden; --verbose shows them)`);
  }
}

/** Brief injection, capability wiring and warm-up: true of every call, so it
 * carries no information about the one being read. */
function isSetup(row: Row): boolean {
  return (
    row.line.startsWith("[system]") ||
    row.line.startsWith("brief-current") ||
    row.line.startsWith("warmup")
  );
}

interface StreamReader {
  getEventPage(args: { limit: number }): Promise<{ streamMaxOffset?: number } | null>;
  getEvents(args: { afterOffset: number; limit: number }): Promise<StreamEventLike[] | null>;
}
