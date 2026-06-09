import { WorkerEntrypoint } from "cloudflare:workers";
import {
  call,
  isProcedure,
  traverseContractProcedures,
  type AnyProcedure,
  type AnyRouter,
} from "@orpc/server";
import { osContract } from "@iterate-com/os-contract";
import {
  generateCodemodeContextTypesFromJsonSchema,
  type JsonSchemaToolDescriptors,
} from "@iterate-com/shared/codemode/json-schema-types";
import { createRequestLogger } from "@iterate-com/shared/request-logging";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import { createD1Client } from "sqlfu";
import type { RequestContext } from "~/request-context.ts";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import type { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { StreamDurableObject } from "~/domains/streams/new-stream-runtime.ts";
import { os } from "~/orpc/orpc.ts";
import { projectsRouter } from "~/orpc/routers/projects.ts";
export {
  createExampleCapabilityProviders,
  createExampleRpcProviderRegistration,
} from "./example-provider-registrations.ts";

type ExampleCapabilityEnv = {
  AI?: {
    run(model: string, input: unknown): Promise<unknown>;
  };
  CODEMODE_SESSION?: DurableObjectNamespace<CodemodeSession>;
  DB?: D1Database;
  DO_CATALOG?: D1Database;
  PROJECT?: DurableObjectNamespace<ProjectDurableObject>;
  STREAM?: DurableObjectNamespace<StreamDurableObject>;
};

type ExampleCapabilityProps = {
  projectId?: string;
};

const OrpcCapabilityContract = osContract.project;
const OrpcCapabilityContractPath = [] as const;

export class AiCapability extends WorkerEntrypoint<ExampleCapabilityEnv, ExampleCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.join(".") !== "run") {
      throw new Error(`AiCapability does not implement ${input.functionPath.join(".")}`);
    }

    const [model, request] = input.args as [string, unknown];
    return await this.run(model, request);
  }

  async run(model: string, request: unknown) {
    if (this.env.AI) {
      return await this.env.AI.run(model, request);
    }

    return {
      model,
      response: `AI binding is not configured; received ${JSON.stringify(request)}`,
    };
  }
}

export class OrpcCapability extends WorkerEntrypoint<ExampleCapabilityEnv, ExampleCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const path = input.functionPath.join(".");
    if (path === "listProcedures") {
      return createOrpcProcedureListing(input.path.slice(0, input.path.length - 1));
    }
    if (input.functionPath.length > 0) {
      const procedure = resolveOrpcProcedure({
        path: ["project", ...input.functionPath],
        router: os.router({ project: projectsRouter.project } as never) as unknown as AnyRouter,
      });
      return await call(
        procedure,
        readUnaryOrpcInput(input, requireProviderProjectId(this.ctx.props)),
        {
          context: createCodemodeOrpcContext({
            ctx: this.ctx,
            env: this.env,
            props: this.ctx.props,
          }),
          path: input.functionPath,
        } as never,
      );
    }

    throw new Error(`OrpcCapability does not implement ${path}`);
  }

  async listProcedures() {
    return createOrpcProcedureListing(["env", "PROJECT", "orpc"]);
  }
}

function createOrpcProcedureListing(providerPath: readonly string[]) {
  const tools: JsonSchemaToolDescriptors = {};

  traverseContractProcedures(
    { router: OrpcCapabilityContract, path: OrpcCapabilityContractPath },
    ({ contract, path }) => {
      const definition = readOrpcDefinition(contract);
      const toolPath = path.join(".");
      const inputSchema = stripProjectSlugOrId(
        readJsonSchema(definition.inputSchema) ?? {
          type: "object",
          additionalProperties: true,
        },
      );
      const outputSchema = readJsonSchema(definition.outputSchema);

      tools[toolPath] = {
        description: definition.route.description,
        inputSchema,
        ...(outputSchema == null ? {} : { outputSchema }),
      };
    },
  );

  tools.listProcedures = {
    description: "Return the TypeScript declaration for this project-bound OS API provider.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: { type: "string" },
  };

  return generateCodemodeContextTypesFromJsonSchema({
    namespace: providerPath.length > 0 ? [...providerPath] : ["os"],
    tools,
  });
}

function stripProjectSlugOrId(
  schema: JsonSchemaToolDescriptors[string]["inputSchema"],
): JsonSchemaToolDescriptors[string]["inputSchema"] {
  if (schema.type !== "object" && !schema.properties) {
    return schema;
  }

  const properties = { ...(schema.properties ?? {}) };
  delete properties.projectSlugOrId;

  return {
    ...schema,
    properties,
    required: schema.required?.filter((field) => field !== "projectSlugOrId"),
  };
}

function readOrpcDefinition(contract: unknown): {
  inputSchema: unknown;
  outputSchema: unknown;
  route: {
    description?: string;
    method?: string;
    path?: string;
    tags?: string[];
  };
} {
  const definition = (contract as { "~orpc"?: unknown })["~orpc"];
  if (!definition || typeof definition !== "object") {
    throw new Error("Expected oRPC procedure metadata while listing codemode procedures.");
  }

  const record = definition as Record<string, unknown>;
  const route = record.route && typeof record.route === "object" ? record.route : {};
  return {
    inputSchema: record.inputSchema,
    outputSchema: record.outputSchema,
    route: route as {
      description?: string;
      method?: string;
      path?: string;
      tags?: string[];
    },
  };
}

function readJsonSchema(schema: unknown) {
  if (!schema || typeof schema !== "object") return null;
  const toJSONSchema = (schema as { toJSONSchema?: unknown }).toJSONSchema;
  if (typeof toJSONSchema !== "function") return null;
  try {
    return toJSONSchema.call(schema) as JsonSchemaToolDescriptors[string]["inputSchema"];
  } catch {
    return null;
  }
}

function resolveOrpcProcedure(input: { path: string[]; router: AnyRouter }): AnyProcedure {
  let target: unknown = input.router;
  for (const segment of input.path) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) {
      throw new Error(`ORPC path ${input.path.join(".")} stopped before ${segment}.`);
    }
    target = (target as Record<string, unknown>)[segment];
  }

  if (!isProcedure(target)) {
    throw new Error(`ORPC path ${input.path.join(".")} is not an implemented procedure.`);
  }

  return target;
}

function readUnaryOrpcInput(input: ExecuteCodemodeFunctionCallInput, projectId: string) {
  if (input.args.length > 1) {
    throw new Error(
      `ORPC codemode calls are unary; ${input.path.join(".")} received ${input.args.length} args.`,
    );
  }

  const request = input.args[0] ?? {};
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error(`ORPC codemode calls require an object input for ${input.path.join(".")}.`);
  }
  return {
    ...(request as Record<string, unknown>),
    projectSlugOrId: projectId,
  };
}

function createCodemodeOrpcContext(input: {
  ctx: ExecutionContext & { props: ExampleCapabilityProps };
  env: ExampleCapabilityEnv;
  props: ExampleCapabilityProps | undefined;
}): RequestContext {
  const env = input.env;
  return {
    // The ORPC capability runs after the original browser request has gone
    // away, so it reconstructs a project-bound request context from scratch.
    // INVARIANT: only `project.*` procedures are exposed through this context
    // (see OrpcCapability below), and none of them read `config`. If you expose
    // a config-reading procedure here, populate config instead of this stub —
    // e.g. `parseConfig(env)` — or it will throw at runtime.
    config: {} as RequestContext["config"],
    db: env.DB ? createD1Client(env.DB) : (undefined as never),
    log: createRequestLogger({
      method: "CODEMODE",
      path: "codemode://orpc-capability",
      requestId: crypto.randomUUID(),
    }),
    projectAccess: {
      projectId: requireProviderProjectId(input.props),
    },
    workerExports: input.ctx.exports,
  };
}

function requireProviderProjectId(props: ExampleCapabilityProps | undefined) {
  const projectId = props?.projectId;
  if (!projectId) throw new Error("Codemode example capability requires ctx.props.projectId.");
  return projectId;
}
