// The itx script runner (the synchronous door).
//
// One function runs a script in a loader isolate against a context and
// leaves a durable two-event record on the context's OWN stream:
//
//   events.iterate.com/itx/script-execution-requested   { executionId, code, context }
//   events.iterate.com/itx/script-execution-completed   { executionId, ok, result|error, durationMs, context }
//
// The events are the RECORD, not the transport: callers get the outcome from
// the return value; everything between the two events is invisible to the
// stream. The same two events ARE the processor-mode protocol — appending a
// requested event with `enqueued: true` makes the context's own processor
// run it (Itx.processEventBatch) and append the completed event; this door
// writes the identical record around an inline run, so both modes converge
// on one journal vocabulary.
//
// No fetch monkeypatching — when the script runs against a project context,
// bare fetch() IS project egress via globalOutbound (Law 5).

import { StreamPath } from "@iterate-com/shared/streams/types";
import type { ItxRuntime } from "./handle.ts";
import { ITX_EVENT_TYPES } from "./itx.ts";
import type { ItxProps } from "./refs.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";

export type ItxScriptOutcome = {
  executionId: string;
  durationMs: number;
  /** console.log/warn/error lines captured from the script's isolate. */
  logs: string[];
} & (
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: string;
      stack?: string;
      /** The ItxError code when the script's throw carried one (errors.ts). */
      code?: string;
    }
);

/** Keep stream payloads bounded; the full value still returns to the caller. */
const MAX_RECORDED_RESULT_CHARS = 64_000;

export async function runItxScript(input: {
  env: Env;
  exports: ItxRuntime["exports"];
  /** Already access-checked by the caller (connect-time auth, Law 3). */
  props: ItxProps;
  /** The owning project; null only for global-context scripts (no egress
   * pipe, no event record — admin-only by construction). */
  projectId: string | null;
  /** Where the two-event record lands. Defaults to the context's own stream
   * (props.context parsed as a coordinate); global scripts have none. */
  record?: { projectId: string | null; path: string };
  /** Use a caller-minted id (e.g. when the requested event already exists). */
  executionId?: string;
  /** Skip the execution-requested append (the caller already recorded one). */
  recordRequested?: boolean;
  /**
   * ONE script shape: `async (itx) => …` — the single argument is the live
   * handle (the parameter name is the author's business; agent scripts call
   * it ctx, that changes nothing). Parameterization is the CALLER's concern:
   * bake values into the source before handing it over (the /api/itx/run
   * endpoint does exactly this for its `vars` API).
   */
  functionSource: string;
}): Promise<ItxScriptOutcome> {
  const loader = input.env.LOADER;
  if (!loader) throw new Error("LOADER binding not available");

  const executionId = input.executionId ?? crypto.randomUUID();
  const startedAtMs = Date.now();
  const record =
    input.record ?? (input.projectId === null ? null : { projectId: input.projectId, path: "/" });

  if (input.recordRequested !== false)
    await recordExecutionEvent(input.env, record, {
      type: ITX_EVENT_TYPES.scriptExecutionRequested,
      payload: {
        code: input.functionSource,
        context: input.props.context,
        executionId,
      },
    });

  const exports = input.exports as unknown as Record<
    string,
    (options: { props: Record<string, unknown> }) => unknown
  >;

  let outcome: ItxScriptOutcome;
  let entrypoint: ({ run(): Promise<string> } & Partial<Disposable>) | undefined;
  // One try/catch from loading through running: a loader failure must still
  // produce an ok:false outcome (and the matching completed event) — never a
  // throw that leaves a dangling execution-requested record.
  try {
    const worker = loader.load({
      compatibilityDate: "2026-04-27",
      env: {
        ITERATE: exports.ItxEntrypoint!({
          props: { ...(input.props as Record<string, unknown>) },
        }),
      },
      // Project scripts get the egress pipe as their global fetch; global
      // scripts inherit the parent's network (they are admin-held by
      // construction — only connect-time auth mints global handles).
      ...(input.projectId !== null
        ? {
            globalOutbound: exports.ProjectEgress!({
              props: {
                context: input.props.context,
                projectId: input.projectId,
              },
            }) as Fetcher,
          }
        : {}),
      mainModule: "itx-script.js",
      modules: { "itx-script.js": itxRunWorkerSource(input.functionSource) },
    });

    entrypoint = worker.getEntrypoint() as unknown as {
      run(): Promise<string>;
    } & Partial<Disposable>;

    const raw = JSON.parse(await entrypoint.run()) as { logs?: string[] } & (
      | { ok: true; result: unknown }
      | { code?: string; error: string; ok: false; stack?: string }
    );
    outcome = {
      ...raw,
      durationMs: Date.now() - startedAtMs,
      executionId,
      logs: raw.logs ?? [],
    };
  } catch (error) {
    outcome = {
      durationMs: Date.now() - startedAtMs,
      error: error instanceof Error ? error.message : String(error),
      executionId,
      logs: [],
      ok: false,
      stack: error instanceof Error ? error.stack : undefined,
    };
  } finally {
    entrypoint?.[Symbol.dispose]?.();
  }

  await recordExecutionEvent(input.env, record, {
    type: ITX_EVENT_TYPES.scriptExecutionCompleted,
    payload: {
      context: input.props.context,
      durationMs: outcome.durationMs,
      executionId,
      ...(outcome.logs.length > 0 ? { logs: outcome.logs.slice(0, 200) } : {}),
      ok: outcome.ok,
      ...(outcome.ok
        ? { result: boundRecordedResult(outcome.result) }
        : { error: outcome.error, stack: outcome.stack }),
    },
  });

  return outcome;
}

function itxRunWorkerSource(functionSource: string) {
  return /* js */ `
    import { WorkerEntrypoint } from "cloudflare:workers";

    const script = (${functionSource});

    const logs = [];
    const stringify = (value) => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
    };
    for (const level of ["log", "warn", "error"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        if (logs.length < 200) logs.push("[" + level + "] " + args.map(stringify).join(" "));
        original(...args);
      };
    }

    export default class extends WorkerEntrypoint {
      async run() {
        try {
          const itx = await this.env.ITERATE.context;
          const result = await script(itx);
          return JSON.stringify({ logs, ok: true, result });
        } catch (error) {
          return JSON.stringify({
            code: typeof error?.code === "string" ? error.code : undefined,
            error: error instanceof Error ? error.message : String(error),
            logs,
            ok: false,
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }
  `;
}

async function recordExecutionEvent(
  env: Env,
  record: { projectId: string | null; path: string } | null,
  event: { type: string; payload: Record<string, unknown> },
): Promise<void> {
  if (record === null) return; // global scripts have no project stream
  try {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId: record.projectId,
      path: StreamPath.parse(record.path),
    });
    await stream.append(event);
  } catch (error) {
    console.error(`[itx] execution event append failed (${event.type}):`, error);
  }
}

function boundRecordedResult(result: unknown): unknown {
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined || serialized.length <= MAX_RECORDED_RESULT_CHARS) return result;
    return {
      __truncated: true,
      chars: serialized.length,
      preview: serialized.slice(0, MAX_RECORDED_RESULT_CHARS),
    };
  } catch {
    return { __truncated: true, reason: "unserializable" };
  }
}
