// root-itx.ts — the admin-only platform root.
//
// This is NOT a context and NOT a Durable Object. It is a tiny, fixed RPC
// surface — "dumb-ass RPC targets" — constructed per connection at the serving
// edge and served through the SAME `pathProxyToInvokeCapability` rule as every
// other itx surface, so `root.projects.list()` and
// `root.streams.get("/x").append(event)` collapse into one `invokeCapability`
// exactly the way a context's dotted calls do.
//
// WHY IT EXISTS. `__null__` (the platform projectId) holds streams that belong
// to no project — integration webhooks, the project catalog, and so on. Those
// are deliberately NOT a connectable project context: you cannot dial into
// `__null__` from a project, and `/api/itx/__null__` is refused. The
// ONLY door to them is here.
//
// WHY IT IS SAFE — with no authority logic of its own:
//   • Admin-only. The edge (server.ts) serves this surface ONLY to a principal
//     whose access is "all" (auth.ts). A non-admin gets 403 at `/api/itx`.
//   • No provide, no dialer. The surface is exactly `projects` and `streams`.
//     There is nothing to inject a capability into and no caller-supplied name
//     to dial — so the cross-project dial holes that a context's dialer must
//     guard against simply cannot be expressed here.
//   • Streams are PRE-SCOPED. The caller supplies a PATH only; the projectId is
//     hardcoded to `__null__`, so a caller cannot pivot to another project's
//     streams through it (and the Stream DO validates the path itself). Names are
//     built from the scope this object already owns, never supplied by the caller.

import { KNOWN_PROJECTS } from "./auth.ts";
import { formatDurableObjectName, PLATFORM_PROJECT_ID } from "./durable-object-names.ts";
import { replayPath } from "./itx.ts";

/** Just the bindings the root needs — kept local so this file never imports the
 *  Worker's full `Env` (and never the other way around). */
type RootEnv = {
  STREAM: { getByName(name: string): any };
};

export class RootItx {
  #env: RootEnv;

  constructor(env: RootEnv) {
    this.#env = env;
  }

  // The same one-operation surface every itx context answers: a dotted call
  // arrives as `invokeCapability({ path, args })` and we replay it onto a plain
  // object of methods. No fold, no log, no built-ins — the methods ARE the
  // surface, so adding a sibling (`users`, `orgs`, …) is just another branch.
  async invokeCapability({
    path,
    args = [],
  }: {
    path: string[];
    args?: unknown[];
  }): Promise<unknown> {
    if (path[0] === "projects") {
      return await replayPath(
        {
          list: () => KNOWN_PROJECTS,
          // A real platform would mint a `prj_…` id and seed the project's first
          // events here; the reference impl just echoes the requested id.
          create: (id: string) => ({ id }),
        },
        path.slice(1),
        args,
      );
    }
    if (path[0] === "streams") {
      return await replayPath(
        {
          // PATH only — the projectId is fixed to the platform plane. Returns a
          // small live handle over the real Stream Durable Object so the caller
          // chains `.append(event)` / `.getEvents()` straight onto it.
          get: (streamPath: string) => {
            const stream = this.#env.STREAM.getByName(
              formatDurableObjectName({ projectId: PLATFORM_PROJECT_ID, path: streamPath }),
            );
            return {
              append: (event: unknown) => stream.append({ event }),
              appendBatch: (events: unknown[]) => stream.appendBatch({ events }),
              getEvents: (range?: {
                afterOffset?: number;
                beforeOffset?: number;
                limit?: number;
              }) => stream.getEvents(range ?? {}),
            };
          },
        },
        path.slice(1),
        args,
      );
    }
    throw new Error(
      `no root capability "${path.join(".")}" (the platform root has projects + streams)`,
    );
  }
}
