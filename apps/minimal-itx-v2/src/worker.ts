import { RpcTarget } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { durableObjectProcessorSubscriber } from "@iterate-com/os/src/domains/streams/engine/shared/callable-subscriber.ts";
import type { Env } from "./env.ts";
import { authenticate, authorizeProjectAccess, KNOWN_PROJECTS } from "./auth.ts";
import { formatDurableObjectName } from "./domains/durable-object-names.ts";
import { AgentDurableObject } from "./domains/agents/agent-durable-object.ts";
import { ProjectDurableObject } from "./domains/projects/project-durable-object.ts";
import { ProjectProcessorContract } from "./domains/projects/project-processor.ts";
import { RepoDurableObject } from "./domains/repos/repo-durable-object.ts";
import { StreamDurableObject } from "./domains/streams/stream-durable-object.ts";
import { ItxContract } from "./itx/processor-contract.ts";
import { ProjectItxRpcTarget, ItxEntrypoint } from "./itx/rpc-targets.ts";

class RootProjectsRpcTarget extends RpcTarget {
  constructor(readonly env: Env) {
    super();
  }

  list() {
    return KNOWN_PROJECTS;
  }

  async create(projectId: string) {
    const durableObjectName = formatDurableObjectName({ path: "/", projectId });
    await this.env.STREAM.getByName(durableObjectName).appendBatch({
      events: [
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `project-subscription:${projectId}:project`,
          payload: {
            subscriptionKey: `project:${projectId}`,
            subscriber: durableObjectProcessorSubscriber({
              bindingName: "PROJECT",
              durableObjectName,
              processorName: ProjectProcessorContract.slug,
            }),
          },
        },
        {
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `project-subscription:${projectId}:itx`,
          payload: {
            subscriptionKey: `itx:${projectId}:/`,
            subscriber: durableObjectProcessorSubscriber({
              bindingName: "PROJECT",
              durableObjectName,
              processorName: ItxContract.slug,
            }),
          },
        },
        {
          type: "events.iterate.com/project/created",
          idempotencyKey: `project-created:${projectId}`,
          payload: { projectId },
        },
      ],
    });
    return { id: projectId };
  }
}

class RootRpcTarget extends RpcTarget {
  constructor(readonly env: Env) {
    super();
  }

  get projects() {
    return new RootProjectsRpcTarget(this.env);
  }
}

function json(status: number, body: unknown) {
  return Response.json(body, { status });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/itx") {
      const principal = authenticate(request);
      if (!principal) return json(401, { error: "missing or invalid token" });
      if (principal.access !== "all") return json(403, { error: "admin token required" });
      return newWorkersWebSocketRpcResponse(request, new RootRpcTarget(env));
    }

    const match = url.pathname.match(/^\/api\/itx\/([^/]+)$/);
    if (!match) return json(404, { error: "not found" });
    const projectId = decodeURIComponent(match[1]);
    const auth = authorizeProjectAccess(request, projectId);
    if (!auth.ok) return json(auth.status, { error: auth.message });

    const itx = new ProjectItxRpcTarget(projectId);
    if (request.method === "POST")
      return json(200, await itx.runScript({ code: await request.text() }));
    return newWorkersWebSocketRpcResponse(request, itx);
  },
} satisfies ExportedHandler<Env>;

export {
  AgentDurableObject,
  ItxEntrypoint,
  ProjectDurableObject,
  RepoDurableObject,
  StreamDurableObject,
};
