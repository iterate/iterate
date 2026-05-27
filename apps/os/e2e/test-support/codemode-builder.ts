// I wrote this by hand

import type { Event } from "@iterate-com/shared/streams/types";
import type { ReceiveFunctionCallResultInput } from "../../src/domains/codemode/durable-objects/codemode-session.ts";
import { streamProjectEventsUntil, type OsClient } from "./os-client.ts";
import type { AiCapability, ReposCapability, WorkspaceDurableObject } from "~/entry.workerd.ts";

type OptionalProjectDeep<T> = T extends (
  params: infer P extends { projectSlugOrId: string },
) => infer R
  ? (params: Omit<P, "projectSlugOrId"> & { projectSlugOrId?: string }) => R
  : { [K in keyof T]: OptionalProjectDeep<T[K]> };

type Stubify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (
        ...args: A
      ) => Awaited<R> extends import("cloudflare:workers").RpcTarget
        ? Stubify<Awaited<R>>
        : Promise<Awaited<R>>
    : Stubify<T[K]>;
};

export type DefaultCtx = {
  os: OptionalProjectDeep<OsClient>;
  ai: AiCapability;
  codemode: { vars: {} };
  env: {};
  repos: Stubify<ReposCapability>;
  workspace: Stubify<ReturnType<WorkspaceDurableObject["getShellState"]>>;
};

type ExecuteScriptParams = Parameters<OsClient["project"]["codemode"]["executeScript"]>[0];
export type CodemodeBuilderOptions = Omit<ExecuteScriptParams, "code">;

export class CodemodeBuilder<Ctx = DefaultCtx> {
  constructor(
    readonly os: OsClient,
    readonly options: CodemodeBuilderOptions,
  ) {}

  stringify<Result>(fn: (ctx: Ctx) => Promise<Result>) {
    const code = fn.toString();
    return code.startsWith("async ") ? code : `async ${code}`;
  }

  define<Result>(fn: (ctx: Ctx) => Promise<Result>) {
    return {
      code: this.stringify(fn),
      $ctx: {} as Ctx,
      $type: {} as Result,
    };
  }

  async start<NewCtx extends Ctx = {} extends Ctx ? any : Ctx, Result = {}>(
    fn: (ctx: NewCtx) => Promise<Result>,
  ) {
    return this.os.project.codemode.executeScript({
      code: this.context<NewCtx>().stringify(fn),
      ...this.options,
    });
  }

  async execute<NewCtx extends Ctx = Ctx, Result = {}>(fn: { (ctx: NewCtx): Promise<Result> }) {
    const started = await this.start(fn);
    const startedPayload = started.event.payload as { scriptExecutionId: string };
    const isCompletedScriptExecution = (
      event: Event,
    ): event is Event & { payload: ReceiveFunctionCallResultInput } =>
      event.type === "events.iterate.com/codemode/script-execution-completed" &&
      (event.payload as ReceiveFunctionCallResultInput).scriptExecutionId ===
        startedPayload.scriptExecutionId;

    const events = await streamProjectEventsUntil({
      afterOffset: started.event.offset > 1 ? started.event.offset - 1 : "start",
      client: this.os,
      projectSlugOrId: this.options.projectSlugOrId,
      streamPath: started.streamPath,
      // todo: proper strongly-typed version of this read-until helper
      predicate: isCompletedScriptExecution,
    });
    const completed = events.find(isCompletedScriptExecution);
    if (!completed) {
      throw new Error(
        `Expected completed script execution ${startedPayload.scriptExecutionId} in stream batch.`,
      );
    }
    const payload = completed.payload;
    return {
      /** Raw payload from the completed event. Use `.success()` instead if you expect a successful result. */
      payload,
      /** Asserts that the script executed successfully and returns the strongly-typed result */
      success: () => {
        if (payload.outcome?.status !== "returned") {
          throw new Error(`codemode: ${payload.outcome?.status}: ${payload.outcome.error}`, {
            cause: completed,
          });
        }
        return payload.outcome.value as Result;
      },
      /** The full completed event object, including the payload. */
      event: completed as Omit<typeof completed, "payload"> & {
        payload: ReceiveFunctionCallResultInput;
      },
      /** All events in the stream batch, including the completed event. */
      events,
      /**
       * a snapshot-friendly copy of the completed event payload. optionally pass in key-value pairs to replace in the whole payload
       * note: each `value` is replaced with `<key>` so `{ requestId: "abc123" }` replaces all `abc123` occurrences in the whole payload with `<requestId>`
       */
      snapshot: (redactions: Record<string, string> = {}) => {
        let json = JSON.stringify(completed.payload);
        // sort by length descending to avoid replacing substrings
        const entries = Object.entries(redactions).sort((a, b) => b[0].length - a[0].length);
        for (const [key, value] of entries) {
          json = json.replaceAll(value, `<${key}>`);
        }
        const snapshottable = JSON.parse(json) as typeof payload;
        snapshottable.durationMs = 999;
        snapshottable.scriptExecutionId = "<script-execution-id>";
        snapshottable.functionCallId = "<function-call-id>";
        return snapshottable;
      },
    };
  }

  /** Type-only method to set the type of the codemode function's context parameter */
  context<NewCtx, Mode extends "extend" | "replace" = "extend">() {
    type ReplacementCtx = Mode extends "extend" ? NewCtx & Ctx : NewCtx;
    return this as CodemodeBuilder<ReplacementCtx>;
  }

  /**
   * Set a string template variable for the codemode function.
   * This will be available to the codemode function as `ctx.codemode.vars.YOUR_VAR`.
   */
  var<Key extends string, Value extends string>(key: Key, value: Value) {
    if (key.trim() === "") {
      throw new Error("Codemode var key must not be blank.");
    }

    type OldCodemode = Ctx extends { codemode: infer OldCodemode } ? OldCodemode : {};
    type OldVars = OldCodemode extends { vars: infer OldVars } ? OldVars : {};
    type NewCtx = Ctx & { codemode: OldCodemode & { vars: OldVars & Record<Key, Value> } };
    return new CodemodeBuilder<NewCtx>(this.os, {
      ...this.options,
      events: [
        ...(this.options.events || []),
        {
          type: "events.iterate.com/codemode/vars-updated",
          payload: { vars: { [key]: value } },
        },
      ],
    });
  }
}
