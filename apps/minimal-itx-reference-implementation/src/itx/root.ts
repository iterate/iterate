// root.ts — the admin-only platform root.
//
// This is NOT a context and NOT a Durable Object. It is a tiny, fixed RPC
// surface constructed per connection at the serving edge and served through the
// SAME `pathInvokerToProxy` rule as every other itx surface, so
// `root.projects.list()` and
// `root.streams.get("/x").append({ event })` collapse into one `invokeCapability`
// exactly the way a context's dotted calls do.
//
// WHY IT EXISTS. `__null__` (the platform projectId) holds streams that belong
// to no project — integration webhooks, the project catalog, and so on. Those
// are deliberately NOT a connectable project context: you cannot connect into
// `__null__` from a project, and `/api/itx/__null__` is refused. The
// ONLY door to them is here.
//
// WHY IT IS SAFE — with no authority logic of its own:
//   • Admin-only. The edge (worker.ts) serves this surface ONLY to a principal
//     whose access is "all" (auth.ts). A non-admin gets 403 at `/api/itx`.
//   • No provide, no address resolver. The surface is exactly `projects` and `streams`.
//     There is nothing to inject a capability into and no caller-supplied name
//     to resolve — so the cross-project address holes that a context's resolver must
//     guard against simply cannot be expressed here.
//   • Streams are PRE-SCOPED. The caller supplies a PATH only; the projectId is
//     hardcoded to `__null__`, so a caller cannot pivot to another project's
//     streams through it (and the Stream DO validates the path itself). Names are
//     built from the scope this object already owns, never supplied by the caller.

import { KNOWN_PROJECTS } from "../auth.ts";
import { formatDurableObjectName, PLATFORM_PROJECT_ID } from "../domains/durable-object-names.ts";
import { StreamRpcTarget } from "../domains/streams/streams-rpc-target.ts";
import type { Env } from "../env.ts";
import { pathInvokerToProxy } from "./path-invoker.ts";
import { replayPath } from "./processor.ts";

type RootEnv = Pick<Env, "PROJECT" | "STREAM">;

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
      return await replayPath({
        target: {
          list: () => KNOWN_PROJECTS,
          // The admin root is the external bootstrap door. Project creation is
          // not magic inside a processor: this calls the Project Durable Object,
          // which subscribes its project + ITX processors to the root stream and
          // appends the first project/created fact.
          create: async (id: string) =>
            await this.#env.PROJECT.getByName(
              formatDurableObjectName({ projectId: id, path: "/" }),
            ).createProject({ projectId: id }),
        },
        path: path.slice(1),
        args,
      });
    }
    if (path[0] === "streams") {
      return await replayPath({
        target: {
          // PATH only — the projectId is fixed to the platform plane. Return a
          // Stream RPC target over the real Stream Durable Object stub, not a
          // copied subset of methods. This keeps callback-heavy subscribe()
          // lifecycle handling identical to apps/os while root stays out of the
          // business of mirroring Stream APIs.
          get: (streamPath: string) => {
            const stream = this.#env.STREAM.getByName(
              formatDurableObjectName({ projectId: PLATFORM_PROJECT_ID, path: streamPath }),
            );
            return pathInvokerToProxy(new StreamRpcTarget(stream));
          },
        },
        path: path.slice(1),
        args,
      });
    }
    throw new Error(
      `no root capability "${path.join(".")}" (the platform root has projects + streams)`,
    );
  }
}
