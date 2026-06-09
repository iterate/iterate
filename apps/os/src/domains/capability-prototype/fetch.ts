import { newWorkersRpcResponse } from "capnweb";

import { FakeIterateCapability } from "./capability.ts";
import type { FakeProjectDurableObject, FakeStreamDurableObject } from "./durable-object.ts";
import type { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import {
  authenticateCapnwebAdmin,
  handleCapnwebAdminCookieRequest,
} from "~/capnweb/admin-auth-cookie.ts";

export const CAPABILITY_PROTOTYPE_PREFIX = "/api/capability-prototype";

type FakeCapabilityAuth =
  | {
      type: "admin-api-secret";
    }
  | {
      projects: string[];
      type: "iterate-auth";
      userId: string;
    };

type FakePrototypeEnv = Env & {
  FAKE_PROJECT: DurableObjectNamespace<FakeProjectDurableObject>;
  FAKE_STREAM: DurableObjectNamespace<FakeStreamDurableObject>;
};

export async function handleCapabilityPrototypeFetch(input: {
  config: AppConfig;
  context: AppContext;
  env: FakePrototypeEnv;
  request: Request;
}) {
  const url = new URL(input.request.url);
  if (
    url.pathname !== CAPABILITY_PROTOTYPE_PREFIX &&
    !url.pathname.startsWith(`${CAPABILITY_PROTOTYPE_PREFIX}/`)
  ) {
    return null;
  }

  if (url.pathname === `${CAPABILITY_PROTOTYPE_PREFIX}/admin-cookie`) {
    return await handleCapnwebAdminCookieRequest({
      config: input.config,
      request: input.request,
    });
  }

  const principal = authenticateCapnwebAdmin({
    config: input.config,
    request: input.request,
  });
  if (!principal) return new Response("Unauthorized", { status: 401 });

  if (url.pathname === `${CAPABILITY_PROTOTYPE_PREFIX}/run`) {
    return await handlePrototypeRun(input);
  }

  if (url.pathname === `${CAPABILITY_PROTOTYPE_PREFIX}/internal-project-append`) {
    const projectId = url.searchParams.get("projectId") ?? "fake_proj_internal";
    return Response.json({
      ...(await input.env.FAKE_PROJECT.getByName(projectId).appendInternalProjectEvent({
        payload: {
          source: "project-do-internal",
        },
        type: "events.iterate.test/project-internal",
      })),
      projectId,
    });
  }

  return await newWorkersRpcResponse(
    input.request,
    new FakeIterateCapability({
      auth: { type: "admin-api-secret" },
      env: input.env,
    }),
  );
}

function prototypeRunWorkerSource(input: { functionSource: string }) {
  return /* js */ `
    import { env, WorkerEntrypoint } from "cloudflare:workers";

    const snippet = (${input.functionSource});
    const ctx = env.ITERATE.context;

    export default class extends WorkerEntrypoint {
      async run(vars) {
        const resolvedCtx = await ctx;
        return await snippet({
          ctx: resolvedCtx,
          env: this.env,
          vars,
        });
      }
    }
  `;
}

async function handlePrototypeRun(input: {
  context: AppContext;
  env: FakePrototypeEnv;
  request: Request;
}) {
  if (!input.env.LOADER) {
    return Response.json({ error: "LOADER binding not available" }, { status: 503 });
  }

  const body = (await input.request.json()) as {
    auth?: FakeCapabilityAuth;
    functionSource?: string;
    vars?: Record<string, unknown>;
  };
  if (typeof body.functionSource !== "string" || body.functionSource.trim() === "") {
    return Response.json({ error: "functionSource is required" }, { status: 400 });
  }

  const worker = input.env.LOADER.load({
    compatibilityDate: "2026-04-27",
    env: {
      ITERATE: fakeIterateEntrypoint(input, body.auth ?? { type: "admin-api-secret" }),
    },
    mainModule: "worker.js",
    modules: {
      "worker.js": prototypeRunWorkerSource({
        functionSource: body.functionSource,
      }),
    },
  });
  const entry = worker.getEntrypoint() as unknown as {
    run(vars: Record<string, unknown>): Promise<unknown>;
  } & Partial<Disposable>;
  try {
    return Response.json(await entry.run(body.vars ?? {}));
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  } finally {
    entry[Symbol.dispose]?.();
  }
}

function fakeIterateEntrypoint(input: { context?: AppContext }, auth: FakeCapabilityAuth) {
  const entrypoint = input.context?.workerExports?.FakeIterateEntrypoint as
    | ((options: { props: { auth: FakeCapabilityAuth } }) => unknown)
    | undefined;
  if (!entrypoint) {
    throw new Error("FakeIterateEntrypoint export is not available");
  }
  return entrypoint({ props: { auth } });
}
