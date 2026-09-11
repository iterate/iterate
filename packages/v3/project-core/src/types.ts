import { RpcTarget, type RpcStub } from "capnweb";
import { z } from "zod";
import type { Target } from "./model.ts";
import { EventRecord, Json, type EventInput } from "./signatures.ts";
import type { BuilderTarget } from "./build.ts";

/** A slash-delimited context path, resolved relative to the current scope by `cd()`. */
export type ContextPath = string;

export type ReadEventsOptions = Readonly<{
  afterOffset?: number;
  limit?: number;
}>;

export type SubscribeOptions = Readonly<{
  afterOffset?: number;
}>;

export const EventPage = z
  .strictObject({
    events: z.array(EventRecord).readonly(),
    afterOffset: z.number().int().nonnegative(),
    throughOffset: z.number().int().nonnegative(),
    head: z.number().int().nonnegative(),
  })
  .readonly();
export type EventPage = z.infer<typeof EventPage>;

/** The current implementation's diagnostic snapshot. It contains no callable capability. */
export const ContextInspection = z
  .strictObject({
    context: z.strictObject({ project: z.string(), path: z.string(), name: z.string() }).readonly(),
    head: z.number().int().nonnegative(),
    settings: z
      .array(z.strictObject({ key: z.string(), value: Json, offset: z.number().int() }).readonly())
      .readonly(),
    lending: z
      .strictObject({
        pagers: z.number().int().nonnegative(),
        borrowed: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        dormant: z.boolean(),
      })
      .readonly(),
    processors: z
      .array(
        z
          .strictObject({
            name: z.string(),
            setting_offset: z.number().int(),
            cursor: z.number().int().nonnegative(),
            attempts: z.number().int().nonnegative(),
            retry_at: z.number().int().nonnegative().nullable(),
            error: z.string().nullable(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();
export type ContextInspection = z.infer<typeof ContextInspection>;
export type ContextAddress = ContextInspection["context"];
/** Observable lifecycle state for live capabilities held by this context. */
export type LendingState = ContextInspection["lending"];
/** Persisted progress and retry state for one configured event processor. */
export type ProcessorState = ContextInspection["processors"][number];

/** A durable mount descriptor accepted by `provide()`. */
export type MountDescriptor = Target;

/** A local Cap'n Web target lent to the context for the lifetime of a returned handle. */
export type LentCapability = RpcTarget;

/** A returned mount or subscription; disposal is idempotent. */
export abstract class HandleTarget extends RpcTarget implements Disposable {
  abstract [Symbol.dispose](): void;
}

export type Handle = RpcStub<HandleTarget>;

export type StreamCallback = (page: EventPage) => Promise<void>;

export type WorkerInput = Omit<WorkerLoaderWorkerCode, "env" | "globalOutbound"> & {
  env?: Record<string, unknown>;
};
/** A session-scoped execution handle, not a durable worker address. */
export abstract class WorkerTarget extends RpcTarget implements Disposable {
  abstract invoke(path: readonly string[], ...args: unknown[]): Promise<unknown>;
  abstract fetch(request: Request): Promise<Response>;
  abstract [Symbol.dispose](): void;
}

/**
 * Server-side Cap'n Web target for one named project context.
 *
 * `invoke()` is intentionally the sole untyped escape hatch for dynamically
 * mounted members. Prefer the typed stream and lifecycle leaves below.
 */
export abstract class ScopeTarget extends RpcTarget {
  abstract readonly build: BuilderTarget;
  abstract cd(path: ContextPath): ScopeTarget;
  abstract invoke(path: readonly string[], ...args: unknown[]): Promise<unknown>;
  abstract append(input: EventInput | readonly EventInput[]): Promise<readonly EventRecord[]>;
  abstract readEvents(options?: ReadEventsOptions): Promise<EventPage>;
  abstract inspect(): Promise<ContextInspection>;
  abstract load(code: WorkerInput, exportName?: string): Promise<WorkerTarget>;
  abstract provide(match: string, target: MountDescriptor | LentCapability): Promise<HandleTarget>;
  abstract subscribe(callback: StreamCallback, options?: SubscribeOptions): Promise<HandleTarget>;
  abstract fetch(request: Request): Promise<Response>;
}

/** Client-side Cap'n Web stub for `ScopeTarget`; it retains RPC pipelining and disposal. */
export type Scope = RpcStub<ScopeTarget>;

export type { EventInput, EventRecord };
