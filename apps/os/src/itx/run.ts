// The itx script runner (record-only mode, itx-next.md §4).
//
// One function runs a script in a loader isolate against a context and
// leaves a durable two-event record on the owning project's /itx stream:
//
//   events.iterate.com/itx/execution-requested   { executionId, code, vars, context }
//   events.iterate.com/itx/execution-completed   { executionId, ok, result|error, durationMs, context }
//
// The events are the RECORD, not the transport: callers get the outcome from
// the return value; everything between the two events is invisible to the
// stream. (This pair replaces codemode's six-event execution protocol.)
// Appends are best-effort, matching the registry's audit posture (D1: the
// caller-visible outcome is authoritative; the stream is history).
//
// No fetch monkeypatching — when the script runs against a project context,
// bare fetch() IS project egress via globalOutbound (Law 5).

import { StreamPath } from "@iterate-com/shared/streams/types";
import type { ItxRuntime } from "./handle.ts";
import { ITX_AUDIT_STREAM_PATH, ITX_EVENT_TYPES } from "./protocol.ts";
import type { ItxProps } from "./protocol.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/new-stream-runtime.ts";

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
  /** Where the two-event record lands. Defaults to the owning project's
   * /itx stream; callers whose loop lives on another stream (e.g. an agent
   * reading completions off its own stream) point this there. */
  record?: { namespace: string; path: string };
  /** Use a caller-minted id (e.g. when the requested event already exists). */
  executionId?: string;
  /** Skip the execution-requested append (the caller already recorded one). */
  recordRequested?: boolean;
  functionSource: string;
  vars?: Record<string, unknown>;
}): Promise<ItxScriptOutcome> {
  const loader = input.env.LOADER;
  if (!loader) throw new Error("LOADER binding not available");

  const executionId = input.executionId ?? crypto.randomUUID();
  const startedAtMs = Date.now();
  const record =
    input.record ??
    (input.projectId === null ? null : { namespace: input.projectId, path: ITX_AUDIT_STREAM_PATH });

  if (input.recordRequested !== false)
    await recordExecutionEvent(input.env, record, {
      type: ITX_EVENT_TYPES.executionRequested,
      payload: {
        code: input.functionSource,
        context: input.props.context,
        executionId,
        vars: input.vars ?? {},
      },
    });

  const exports = input.exports as unknown as Record<
    string,
    (options: { props: Record<string, unknown> }) => unknown
  >;

  let outcome: ItxScriptOutcome;
  let entrypoint:
    | ({ run(vars: Record<string, unknown>): Promise<string> } & Partial<Disposable>)
    | undefined;
  // One try/catch from loading through running: a loader failure must still
  // produce an ok:false outcome (and the matching completed event) — never a
  // throw that leaves a dangling execution-requested record.
  try {
    const worker = loader.load({
      compatibilityDate: "2026-04-27",
      env: {
        ITERATE: exports.ItxEntrypoint!({ props: input.props as Record<string, unknown> }),
      },
      // Project scripts get the egress pipe as their global fetch; global
      // scripts inherit the parent's network (they are admin-held by
      // construction — only connect-time auth mints global handles).
      ...(input.projectId !== null
        ? {
            globalOutbound: exports.ProjectEgress!({
              props: { context: input.props.context, project: input.projectId },
            }) as Fetcher,
          }
        : {}),
      mainModule: "itx-script.js",
      modules: { "itx-script.js": itxRunWorkerSource(input.functionSource) },
    });

    entrypoint = worker.getEntrypoint() as unknown as {
      run(vars: Record<string, unknown>): Promise<string>;
    } & Partial<Disposable>;

    const raw = JSON.parse(await entrypoint.run(input.vars ?? {})) as { logs?: string[] } & (
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
    type: ITX_EVENT_TYPES.executionCompleted,
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
      async run(vars) {
        try {
          const itx = await this.env.ITERATE.context;
          const result = await script({ itx, vars });
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
  record: { namespace: string; path: string } | null,
  event: { type: string; payload: Record<string, unknown> },
): Promise<void> {
  if (record === null) return; // global scripts have no project stream
  try {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: record.namespace,
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
