// runner-entry.ts — THE USERSPACE PROCESSOR RUNNER, as real TypeScript. build-sdk.mjs bundles
// this file into `generated/processor-runner.ts`, which the host injects as `runner.js` beside
// the SDK (`processor.js`) and the user's modules. Being real TS (instead of the hand-written
// template string it replaced), it typechecks against the SAME StreamProcessor/FacetIdentity
// types the host compiles — the drift class where the injected duck quietly diverges from the
// host's contract can no longer exist.
//
// `./cap.js` (the user's module) and `./processor.js` (the SDK) exist only inside the loaded
// isolate — they are esbuild EXTERNALS here.

import { DurableObject } from "cloudflare:workers";
// @ts-expect-error — resolved inside the loaded isolate (the user's module), external at build
import * as user from "./cap.js";
import type { StreamProcessor, ScanWindow } from "./core/processor.ts";
import type { FacetIdentity } from "./processor-facet.ts";
import type { StreamEvent, StreamEventInput } from "./core/events.ts";

interface RunnerEnv {
  /** The owning context — the interposition entrypoint (append/read/invokeCapability/fetch). */
  ITX: {
    append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
    read(
      afterOffset?: number,
      limit?: number,
    ): Promise<{ events: StreamEvent[]; scannedThroughOffset: number }>;
  };
}

export class ProcessorFacetRunner extends DurableObject<RunnerEnv> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #p?: StreamProcessor<any>;

  configure(identity: FacetIdentity): { ok: true } {
    this.ctx.storage.kv.put("identity", identity);
    return { ok: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #processor(): StreamProcessor<any> {
    if (this.#p) return this.#p;
    const identity = this.ctx.storage.kv.get("identity") as FacetIdentity | undefined;
    if (!identity) throw new Error("processor runner: not configured (call configure() first)");
    const exportName = identity.export ?? "default";
    const C = (user as Record<string, unknown>)[exportName];
    if (typeof C !== "function")
      throw new Error(`processor runner: no processor export ${JSON.stringify(exportName)}`);
    this.#p = new (C as new (args: unknown) => StreamProcessor<unknown>)({
      stream: {
        append: (...events: StreamEventInput[]) => this.env.ITX.append(...events),
        read: (after?: number, limit?: number) => this.env.ITX.read(after, limit),
      },
      storage: {
        get: (key: string) => this.ctx.storage.kv.get(key),
        put: (key: string, value: unknown) => this.ctx.storage.kv.put(key, value),
      },
      path: identity.path,
      projectId: identity.projectId,
    });
    return this.#p;
  }

  processEventBatch(events: StreamEvent[], window: ScanWindow): Promise<void> {
    return this.#processor().processEventBatch(events, window);
  }
  snapshot() {
    return this.#processor().snapshot();
  }
  liveSnapshot() {
    return this.#processor().liveSnapshot();
  }
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void> {
    return this.#processor().waitUntilProcessed(input);
  }
}

export default {
  fetch: () => new Response("processor facet runner\n"),
};
