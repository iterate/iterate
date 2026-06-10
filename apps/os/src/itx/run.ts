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

export type ItxScriptOutcome = { executionId: string; durationMs: number } & (
  | { ok: true; result: unknown }
  | { ok: false; error: string; stack?: string }
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
  functionSource: string;
  vars?: Record<string, unknown>;
}): Promise<ItxScriptOutcome> {
  const loader = input.env.LOADER;
  if (!loader) throw new Error("LOADER binding not available");

  const executionId = crypto.randomUUID();
  const startedAtMs = Date.now();

  await recordExecutionEvent(input, {
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

  const entrypoint = worker.getEntrypoint() as unknown as {
    run(vars: Record<string, unknown>): Promise<string>;
  } & Partial<Disposable>;

  let outcome: ItxScriptOutcome;
  try {
    const raw = JSON.parse(await entrypoint.run(input.vars ?? {})) as
      | { ok: true; result: unknown }
      | { error: string; ok: false; stack?: string };
    outcome = { ...raw, durationMs: Date.now() - startedAtMs, executionId };
  } catch (error) {
    outcome = {
      durationMs: Date.now() - startedAtMs,
      error: error instanceof Error ? error.message : String(error),
      executionId,
      ok: false,
      stack: error instanceof Error ? error.stack : undefined,
    };
  } finally {
    entrypoint[Symbol.dispose]?.();
  }

  await recordExecutionEvent(input, {
    type: ITX_EVENT_TYPES.executionCompleted,
    payload: {
      context: input.props.context,
      durationMs: outcome.durationMs,
      executionId,
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

    export default class extends WorkerEntrypoint {
      async run(vars) {
        try {
          const itx = await this.env.ITERATE.context;
          const result = await script({ itx, vars });
          return JSON.stringify({ ok: true, result });
        } catch (error) {
          return JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }
  `;
}

async function recordExecutionEvent(
  input: { env: Env; projectId: string | null },
  event: { type: string; payload: Record<string, unknown> },
): Promise<void> {
  if (input.projectId === null) return; // global scripts have no project stream
  try {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: input.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: input.projectId,
      path: StreamPath.parse(ITX_AUDIT_STREAM_PATH),
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
