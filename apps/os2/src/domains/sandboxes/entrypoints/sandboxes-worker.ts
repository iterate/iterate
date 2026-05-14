import { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import { ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import { SandboxDurableObject } from "~/domains/sandboxes/durable-objects/sandbox-durable-object.ts";
import {
  SandboxesCapability,
  type SandboxExecInput,
} from "~/domains/sandboxes/entrypoints/sandboxes-capability.ts";

export { Sandbox } from "@cloudflare/sandbox";
export { ReposCapability, RepoDurableObject, SandboxDurableObject, SandboxesCapability };
export { StreamDurableObject };

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

type SandboxWorkerExports = {
  SandboxesCapability: unknown;
};

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/rpc") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    try {
      const body = SandboxWorkerRequest(await request.json());
      const sandboxes = getSandboxesCapabilityFromExports({
        exports: ctx.exports as unknown as SandboxWorkerExports,
        projectId: body.projectId,
      });

      switch (body.op) {
        case "createInfo":
          return Response.json(await sandboxes.createInfo(body.input));
        case "destroyRuntime":
          return Response.json(await sandboxes.destroyRuntime(body.input));
        case "exec":
          return Response.json(await sandboxes.exec(body.input));
        case "getInfo":
          return Response.json(await sandboxes.getInfo(body.input));
        case "list":
          return Response.json({ sandboxes: await sandboxes.list() });
        case "wake":
          return Response.json(await sandboxes.wake(body.input));
      }
    } catch (error) {
      console.error("[sandboxes-worker] rpc failed", {
        error: errorMessage(error),
      });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  },
};

function getSandboxesCapabilityFromExports(input: {
  exports: SandboxWorkerExports;
  projectId: string;
}) {
  const factory = input.exports.SandboxesCapability as unknown as (options: {
    props: { projectId: string };
  }) => Pick<
    SandboxesCapability,
    "createInfo" | "destroyRuntime" | "exec" | "getInfo" | "list" | "wake"
  >;

  return factory({ props: { projectId: input.projectId } });
}

function SandboxWorkerRequest(value: unknown): SandboxWorkerRequest {
  if (value == null || typeof value !== "object") {
    throw new Error("Sandbox worker request body must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.projectId !== "string" || record.projectId.trim() === "") {
    throw new Error("projectId is required.");
  }

  switch (record.op) {
    case "createInfo":
    case "destroyRuntime":
    case "getInfo":
    case "wake":
      return {
        input: readSlugInput(record.input),
        op: record.op,
        projectId: record.projectId,
      };
    case "exec":
      return {
        input: readExecInput(record.input),
        op: record.op,
        projectId: record.projectId,
      };
    case "list":
      return {
        op: "list",
        projectId: record.projectId,
      };
    default:
      throw new Error("Unsupported sandbox worker operation.");
  }
}

function readSlugInput(value: unknown) {
  if (value == null || typeof value !== "object") {
    throw new Error("Sandbox operation input must be an object.");
  }

  const slug = (value as Record<string, unknown>).slug;
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new Error("Sandbox slug is required.");
  }

  return { slug };
}

function readExecInput(value: unknown) {
  const input = readSlugInput(value);
  const exec = (value as Record<string, unknown>).exec;
  if (exec == null || typeof exec !== "object") {
    throw new Error("Sandbox exec input is required.");
  }

  const execRecord = exec as Record<string, unknown>;
  if (typeof execRecord.command !== "string" || execRecord.command.trim() === "") {
    throw new Error("Sandbox exec command is required.");
  }

  return {
    ...input,
    exec: {
      command: execRecord.command,
      ...(typeof execRecord.cwd === "string" ? { cwd: execRecord.cwd } : {}),
      ...(typeof execRecord.timeout === "number" ? { timeout: execRecord.timeout } : {}),
      ...(isStringRecord(execRecord.env) ? { env: execRecord.env } : {}),
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string | undefined> {
  if (value == null || typeof value !== "object") return false;
  return Object.values(value).every(
    (item) => typeof item === "string" || typeof item === "undefined",
  );
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSandboxSecrets(message);
}

function redactSandboxSecrets(message: string) {
  return message.replaceAll(/Bearer\s+art_v1_[^'"\s]+/g, "Bearer [REDACTED]");
}
