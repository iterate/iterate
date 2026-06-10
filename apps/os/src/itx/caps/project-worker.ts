// ProjectWorker: the loopback forwarder that makes the project's OWN worker
// (built from the project repo) a capability target — user space, same shape
// as first-party (the §1 litmus test's second half).
//
//   await itx.caps.define({
//     invoke: "path-call",
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
// "members") ride in props, because the cap's own entrypoint/invoke describe
// THIS forwarder hop. props.projectId is registry-injected (spoof-proof).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { CapInvoke, PathCall } from "../protocol.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";

export type ProjectWorkerProps = {
  /** Injected by the registry at dial time — never definer-supplied. */
  projectId?: string;
  /** The named export of the project worker to call (default export if omitted). */
  export?: string;
  /** How to call the user's export: members replay (default) or one call({path,args}). */
  invoke?: CapInvoke;
  cap?: string;
  context?: string;
};

export class ProjectWorker extends WorkerEntrypoint<Env, ProjectWorkerProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    if (!props.projectId) {
      throw new Error("ProjectWorker needs registry-injected projectId props.");
    }
    const { cap, context, export: exportName, invoke, projectId, ...definerProps } = props;
    const project = this.env.PROJECT.getByName(
      getProjectDurableObjectName(projectId),
    ) as unknown as ProjectDurableObject;
    return await project.itxProjectWorkerCall({
      call: input,
      entrypoint: exportName,
      invoke: invoke ?? "members",
      // The user's export sees its definer parameterization plus the same
      // attribution every dialable target gets.
      props: { ...definerProps, cap, context, projectId },
    });
  }
}
