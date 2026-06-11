// ProjectWorker: the loopback forwarder that makes the project's OWN worker
// (built from the project repo) a capability target — user space, same shape
// as first-party (the §1 litmus test's second half).
//
//   await itx.provideCapability({
//     name: "petstore",
//     target: {
//       type: "rpc",
//       worker: { type: "loopback" },
//       entrypoint: "ProjectWorker",
//       props: { export: "PetstoreClient", invoke: "path-call", specUrl: "…" },
//     },
//   });
//
// Why a forwarder instead of a dedicated WorkerRef kind: loader entrypoints
// cannot cross an RPC boundary, so the call must replay INSIDE the Project
// DO regardless — and a loopback with props needs no new union member, no
// registry hook, and works identically from child contexts. The price is
// that `export` (the user's class) and `invoke` (how to call it; default
// "members") ride in props: the kernel speaks ONE convention (this
// forwarder's call({ path, args })), and how the INNER/user object is
// treated is the forwarder's own business, never kernel data.
// props.projectId is registry-injected (spoof-proof).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { PathCall } from "../itx.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";

/**
 * How a FORWARDER treats the inner object it fronts (ProjectWorker's user
 * export, UrlDial's remote main): replay the path on its members (default)
 * or hand it one call({ path, args }). This is forwarder props, not kernel
 * data — the registry itself knows exactly one calling convention.
 */
export type WorkerInvokeMode = "members" | "path-call";

export type ProjectWorkerProps = {
  /** Injected by the registry at dial time — never provider-supplied. */
  projectId?: string;
  /** The named export of the project worker to call (default export if omitted). */
  export?: string;
  /** How to call the user's export: members replay (default) or one call({path,args}). */
  invoke?: WorkerInvokeMode;
  capability?: string;
  context?: string;
};

export class ProjectWorker extends WorkerEntrypoint<Env, ProjectWorkerProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    if (!props.projectId) {
      throw new Error("ProjectWorker needs registry-injected projectId props.");
    }
    const { capability, context, export: exportName, invoke, projectId, ...providerProps } = props;
    const project = this.env.PROJECT.getByName(
      getProjectDurableObjectName(projectId),
    ) as unknown as ProjectDurableObject;
    return await project.itxProjectWorkerCall({
      call: input,
      entrypoint: exportName,
      invoke: invoke ?? "members",
      // The user's export sees its provider parameterization plus the same
      // attribution every dialable target gets.
      props: { ...providerProps, capability, context, projectId },
    });
  }
}
