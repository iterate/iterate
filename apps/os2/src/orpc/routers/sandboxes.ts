import { ORPCError } from "@orpc/server";
import type { AppContext } from "~/context.ts";
import type {
  SandboxCatalogRecord,
  SandboxExecInput,
} from "~/domains/sandboxes/entrypoints/sandboxes-capability.ts";
import type { SandboxInfo } from "~/domains/sandboxes/durable-objects/sandbox-durable-object.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectSandboxesRouter = {
  list: os.project.sandboxes.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    return await callSandboxWorker<{ sandboxes: SandboxCatalogRecord[] }>(context, {
      op: "list",
      projectId: project.id,
    });
  }),
  create: os.project.sandboxes.create
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        return await callSandboxWorker<SandboxInfo>(context, {
          input: { slug: input.slug },
          op: "createInfo",
          projectId: project.id,
        });
      } catch (error) {
        throw toSandboxORPCError(error);
      }
    }),
  get: os.project.sandboxes.get.use(projectScopeMiddleware).handler(async ({ context, input }) => {
    const project = requireProjectScope(context);
    try {
      return await callSandboxWorker<SandboxInfo>(context, {
        input: { slug: input.sandboxSlug },
        op: "getInfo",
        projectId: project.id,
      });
    } catch (error) {
      throw toSandboxORPCError(error);
    }
  }),
  wake: os.project.sandboxes.wake
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        return await callSandboxWorker<SandboxInfo>(context, {
          input: { slug: input.sandboxSlug },
          op: "wake",
          projectId: project.id,
        });
      } catch (error) {
        throw toSandboxORPCError(error);
      }
    }),
  exec: os.project.sandboxes.exec
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        return await callSandboxWorker(context, {
          input: {
            exec: {
              command: input.command,
              cwd: input.cwd,
              env: input.env,
              timeout: input.timeout,
            },
            slug: input.sandboxSlug,
          },
          op: "exec",
          projectId: project.id,
        });
      } catch (error) {
        throw toSandboxORPCError(error);
      }
    }),
  destroyRuntime: os.project.sandboxes.destroyRuntime
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        return await callSandboxWorker<SandboxInfo>(context, {
          input: { slug: input.sandboxSlug },
          op: "destroyRuntime",
          projectId: project.id,
        });
      } catch (error) {
        throw toSandboxORPCError(error);
      }
    }),
};

type SandboxWorkerRequest =
  | {
      input: { slug: string };
      op: "createInfo" | "destroyRuntime" | "getInfo" | "wake";
      projectId: string;
    }
  | {
      input: { exec: SandboxExecInput; slug: string };
      op: "exec";
      projectId: string;
    }
  | {
      op: "list";
      projectId: string;
    };

async function callSandboxWorker<T = unknown>(
  context: AppContext,
  body: SandboxWorkerRequest,
): Promise<T> {
  const service = context.callableEnv?.SANDBOXES;
  if (!isFetcher(service)) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "SANDBOXES service binding is not configured.",
    });
  }

  const response = await service.fetch("https://sandboxes.internal/rpc", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    const responseBody = await response.text();
    const result = parseSandboxWorkerError(responseBody);

    throw new Error(result.error || `Sandbox worker returned ${response.status}`);
  }

  return (await response.json()) as T;
}

function isFetcher(value: unknown): value is Fetcher {
  return (
    value != null &&
    typeof value === "object" &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function"
  );
}

function parseSandboxWorkerError(responseBody: string): { error?: string } {
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (parsed != null && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string") return { error };
    }
  } catch {}

  return { error: responseBody };
}

function toSandboxORPCError(error: unknown) {
  if (error instanceof ORPCError) return error;
  if (!(error instanceof Error)) return error;

  if (error.message.includes("not found")) {
    return new ORPCError("NOT_FOUND", { message: error.message });
  }

  if (error.message.includes("slug is required") || error.message.includes("must be lowercase")) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }

  return error;
}
