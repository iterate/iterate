// A stateless app the root project worker routes to when ingress selects the
// "hello" app. It gets the full project itx through env.ITX, and the same
// base-class surface as the root worker — add a getter here and it is an
// `itx.worker` capability on THIS app via `itx.workers.get(ref)`.
import { IterateWorkerEntrypoint } from "iterate/sdk";

export class HelloApp extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
    using itx = await this.env.ITX.get();
    const description = await itx.__describe();
    return Response.json({
      app: "hello",
      path: new URL(req.url).pathname,
      projectId: description.projectId,
    });
  }
}
