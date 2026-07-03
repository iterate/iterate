import { WorkerEntrypoint } from "cloudflare:workers";
import type { ProjectRpcTarget } from "../../sdk.ts";

// A stateless app: a plain WorkerEntrypoint the root project worker routes
// to when ingress selects the "hello" app. It still gets the full project
// itx through env.ITX. Built from a masked snapshot of this repo (see the
// APPS map in the root worker.ts), so it can import shared modules like
// sdk.ts.
export default class HelloApp extends WorkerEntrypoint<{
  ITX: { get(): Promise<ProjectRpcTarget> };
}> {
  async fetch(req: Request): Promise<Response> {
    const project = await this.env.ITX.get();
    const description = await project.__describe();
    return Response.json({
      app: "hello",
      path: new URL(req.url).pathname,
      projectId: description.projectId,
    });
  }
}
