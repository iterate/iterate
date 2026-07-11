// `iterate/sdk` — what an iterate project repo imports from.
//
// The platform's public capability types (Project, Stream, StreamEvent,
// ItxBinding, …) are generated from the platform's RpcTargets into
// ./itx-api.generated.ts (regenerate from apps/os: `pnpm generate:itx-api`)
// and re-exported here. Hand-written helpers for project code accumulate in
// this file.
//
// Runtime exports here reach dynamic workers WITHOUT an npm install: the
// platform embeds this module (compiled to plain JS) as the `iterate/sdk`
// virtual module in every dynamic worker build — see apps/os
// iterate-sdk-virtual-module.generated.ts. The published package is still the
// editor/typecheck story; keep runtime code here dependency-free (only
// `cloudflare:workers` imports) so the embed stays self-contained.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { DynamicWorkerRef, ItxBinding } from "./itx-api.generated";

// Extensionless on purpose: this specifier lands verbatim in the published
// dist/sdk.d.ts, where it must resolve to dist/itx-api.generated.d.ts.
export type * from "./itx-api.generated";

/**
 * Base class for a project worker's default export: a WorkerEntrypoint whose
 * env carries the platform's ITX binding, plus the platform ceremony a
 * project worker needs but shouldn't have to hand-roll.
 */
export class BaseProjectEntrypoint<
  Env extends { ITX: ItxBinding } = { ITX: ItxBinding },
> extends WorkerEntrypoint<Env> {
  /**
   * Forward a request to one of the project's dynamic workers (an "app") —
   * pages, APIs, streaming bodies, and WebSocket upgrades all ride through.
   *
   * Why this is a real `env.ITX.fetch` hop with the ref in a header, and not
   * a method call on the app: workerd only performs protocol work — WebSocket
   * 101 upgrades, streaming response bodies — through genuine `fetch` handler
   * hops between workers. Calling `fetch` (or anything else) on an app handle
   * from `project.workers.get(ref)` is ordinary RPC: arguments and results
   * are serialized copies, so a Response carrying a socket cannot cross it
   * (workerd throws a DataCloneError). And because a fetch hop's only side
   * channel for "which worker do I mean" is the request itself, the target
   * ref rides the x-iterate-worker-dispatch header (JSON
   * `{ ref, buildBudgetMs? }` — the same ref shape `project.workers.get`
   * takes). Method calls on apps still go through `project.workers.get(ref)`
   * RPC dispatch; HTTP never does.
   *
   * A cold build past `buildBudgetMs` (default 15s) answers a 503 building
   * page that refreshes itself, marked with x-iterate-worker-building —
   * intercept that response here to render your own.
   */
  protected async fetchDynamicWorker(
    req: Request,
    ref: DynamicWorkerRef,
    opts?: { buildBudgetMs?: number },
  ): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.set(
      "x-iterate-worker-dispatch",
      JSON.stringify({ buildBudgetMs: opts?.buildBudgetMs ?? 15_000, ref }),
    );
    return await this.env.ITX.fetch(new Request(req, { headers }));
  }
}
