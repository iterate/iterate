import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  call,
  isProcedure,
  traverseContractProcedures,
  type AnyProcedure,
  type AnyRouter,
} from "@orpc/server";
import { osContract } from "@iterate-com/os2-contract";
import {
  generateCodemodeContextTypesFromJsonSchema,
  type JsonSchemaToolDescriptors,
} from "@iterate-com/shared/codemode/json-schema-types";
import { createRequestLogger } from "@iterate-com/shared/request-logging";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import { createD1Client } from "sqlfu";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import manifest from "~/app.ts";
import type { AppContext } from "~/context.ts";
import type { ProjectDurableObject } from "~/durable-objects/project-durable-object.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import { os } from "~/orpc/orpc.ts";
import { testRouter } from "~/orpc/routers/test.ts";
export {
  createExampleCapabilityProviders,
  createExampleRpcProviderRegistration,
  createWorkspaceProviderRegistration,
} from "./example-provider-registrations.ts";

type ExampleCapabilityEnv = {
  AGENT?: DurableObjectNamespace<AgentDurableObject>;
  AI?: {
    run(model: string, input: unknown): Promise<unknown>;
  };
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  CODEMODE_SESSION?: AppContext["codemodeSession"];
  DB?: D1Database;
  DO_CATALOG?: D1Database;
  PROJECT?: DurableObjectNamespace<ProjectDurableObject>;
  REPO?: DurableObjectNamespace<RepoDurableObject>;
  SLACK_BOT_TOKEN?: string;
  STREAM?: DurableObjectNamespace<StreamDurableObject>;
};

type ExampleCapabilityProps = {
  activeOrganization?: ActiveOrganizationAuth;
  projectId?: string;
};

const OrpcCapabilityContract = osContract.test;
const OrpcCapabilityContractPath = ["test"] as const;

export class AiCapability extends WorkerEntrypoint<ExampleCapabilityEnv, ExampleCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.join(".") !== "run") {
      throw new Error(`AiCapability does not implement ${input.functionPath.join(".")}`);
    }

    const [model, request] = input.args as [string, unknown];
    if (this.env.AI) {
      return await this.env.AI.run(model, request);
    }

    return {
      model,
      response: `AI binding is not configured; received ${JSON.stringify(request)}`,
    };
  }
}

export class RepoCapability extends WorkerEntrypoint<ExampleCapabilityEnv, ExampleCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.join(".") !== "get") {
      throw new Error(`RepoCapability does not implement ${input.functionPath.join(".")}`);
    }
    if (!this.env.REPO) {
      throw new Error("REPO Durable Object namespace is not configured.");
    }

    const [{ slug }] = input.args as [{ slug?: string }];
    const projectId = this.requireProjectId();
    return new RepoHandle(this.env.REPO.getByName(`${projectId}:${slug ?? "default"}`));
  }

  private requireProjectId() {
    return requireProviderProjectId(this.ctx.props);
  }
}

export class RepoDurableObject extends DurableObject {
  async proofOfConcept(input: { callback?: (args: unknown) => unknown; message?: string }) {
    const payload = {
      repoName: this.ctx.id.name,
      message: input.message ?? "repo proof of concept",
    };
    await input.callback?.(payload);
    return payload;
  }
}

class RepoHandle extends RpcTarget {
  readonly #repo: DurableObjectStub<RepoDurableObject>;

  constructor(repo: DurableObjectStub<RepoDurableObject>) {
    super();
    this.#repo = repo;
  }

  /**
   * This handle deliberately forwards to the Durable Object rather than
   * exposing the namespace-generated DO stub itself. Workers RPC documents
   * `RpcTarget` instances and received RPC stubs as passable live values; the
   * facade keeps that live shape while the DO address stays private capability
   * state inside the provider.
   */
  async proofOfConcept(input: { callback?: (args: unknown) => unknown; message?: string }) {
    return await this.#repo.proofOfConcept(input);
  }
}

export class WorkspaceDurableObject extends DurableObject {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.join(".") !== "proofOfConcept") {
      throw new Error(`WorkspaceDurableObject does not implement ${input.functionPath.join(".")}`);
    }

    const [request] = input.args as [{ callback?: (args: unknown) => unknown; message?: string }];
    const payload = {
      workspaceName: this.ctx.id.name,
      message: request?.message ?? "workspace proof of concept",
    };
    await request?.callback?.(payload);
    return payload;
  }
}

export class AgentCapability extends WorkerEntrypoint<
  ExampleCapabilityEnv,
  ExampleCapabilityProps
> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.length !== 0) {
      throw new Error(
        `AgentCapability is unary and expected an empty functionPath, received ${input.functionPath.join(".")}`,
      );
    }
    if (!this.env.AGENT) {
      throw new Error("AGENT Durable Object namespace is not configured.");
    }

    return new AgentHandle(this.env.AGENT.getByName(requireProviderProjectId(this.ctx.props)));
  }
}

export class AgentDurableObject extends DurableObject {
  async sendMessage(input: { message: string; subPath?: string }) {
    return {
      agentName: this.ctx.id.name,
      message: input.message,
      subPath: input.subPath ?? "default",
    };
  }

  async doThing(input: { label: string; value: number }) {
    return {
      agentName: this.ctx.id.name,
      label: input.label,
      value: input.value,
      doubled: input.value * 2,
    };
  }
}

class AgentHandle extends RpcTarget {
  readonly #agent: DurableObjectStub<AgentDurableObject>;

  constructor(agent: DurableObjectStub<AgentDurableObject>) {
    super();
    this.#agent = agent;
  }

  async sendMessage(input: { message: string; subPath?: string }) {
    return await this.#agent.sendMessage(input);
  }

  async doThing(input: { label: string; value: number }) {
    return await this.#agent.doThing(input);
  }
}

export class OrpcCapability extends WorkerEntrypoint<ExampleCapabilityEnv, ExampleCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const path = input.functionPath.join(".");
    if (path === "listProcedures") {
      return createOrpcProcedureListing();
    }
    if (input.functionPath.length > 0) {
      const procedure = resolveOrpcProcedure({
        path: input.functionPath,
        router: os.router(testRouter as never) as unknown as AnyRouter,
      });
      return await call(procedure, readUnaryOrpcInput(input), {
        context: createCodemodeOrpcContext({
          env: this.env,
          props: this.ctx.props,
        }),
        path: input.functionPath,
      } as never);
    }

    throw new Error(`OrpcCapability does not implement ${path}`);
  }
}

export class SlackCapability extends WorkerEntrypoint<
  ExampleCapabilityEnv,
  ExampleCapabilityProps
> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    // Slack's Web API is already method-path based (`chat.postMessage`,
    // `conversations.list`, ...), so this capability intentionally keeps the
    // provider glue generic: codemode path segments become the Slack method
    // name, and the single codemode arg becomes the JSON request body.
    const method = input.functionPath.join(".");
    if (!method) {
      throw new Error("SlackCapability expected a Slack Web API method path.");
    }
    if (input.args.length > 1) {
      throw new Error(
        `Slack codemode calls are unary; ${input.path.join(".")} received ${input.args.length} args.`,
      );
    }

    const token = this.env.SLACK_BOT_TOKEN ?? this.env.APP_CONFIG_SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("SlackCapability requires SLACK_BOT_TOKEN or APP_CONFIG_SLACK_BOT_TOKEN.");
    }

    const [body] = input.args as [Record<string, unknown> | undefined];
    return await callSlackWebApi({
      body: body ?? {},
      method,
      token,
    });
  }
}

export async function callSlackWebApi(input: {
  body: Record<string, unknown>;
  method: string;
  token: string;
}) {
  const response = await fetch(`https://slack.com/api/${input.method}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  const result = (await response.json()) as { error?: string; ok?: boolean } & Record<
    string,
    unknown
  >;
  if (!response.ok || result.ok === false) {
    const error = typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
    throw new Error(`Slack Web API ${input.method} failed: ${error}`);
  }
  return result;
}

function createOrpcProcedureListing() {
  const tools: JsonSchemaToolDescriptors = {};
  const procedures: Array<{
    description?: string;
    method?: string;
    path: string;
    routePath?: string;
    signature: string;
    tags?: string[];
  }> = [];

  traverseContractProcedures(
    { router: OrpcCapabilityContract, path: OrpcCapabilityContractPath },
    ({ contract, path }) => {
      const definition = readOrpcDefinition(contract);
      const toolPath = path.join(".");
      const typeBase = path.map((segment) => segment[0]?.toUpperCase() + segment.slice(1)).join("");
      const inputType = `${typeBase}Input`;
      const outputType = `${typeBase}Output`;
      const inputSchema = readJsonSchema(definition.inputSchema) ?? {
        type: "object",
        additionalProperties: true,
      };
      const outputSchema = readJsonSchema(definition.outputSchema);

      tools[toolPath] = {
        description: definition.route.description,
        inputSchema,
        ...(outputSchema == null ? {} : { outputSchema }),
      };
      procedures.push({
        description: definition.route.description,
        method: definition.route.method,
        path: toolPath,
        routePath: definition.route.path,
        signature: `(input: ${inputType}) => Promise<${outputType}>`,
        tags: definition.route.tags,
      });
    },
  );

  return {
    procedures,
    typeDefinitions: generateCodemodeContextTypesFromJsonSchema({
      namespace: ["os"],
      tools,
    }),
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
  return toJSONSchema.call(schema) as JsonSchemaToolDescriptors[string]["inputSchema"];
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

function readUnaryOrpcInput(input: ExecuteCodemodeFunctionCallInput) {
  if (input.args.length > 1) {
    throw new Error(
      `ORPC codemode calls are unary; ${input.path.join(".")} received ${input.args.length} args.`,
    );
  }

  return input.args[0];
}

function createCodemodeOrpcContext(input: {
  env: ExampleCapabilityEnv;
  props: ExampleCapabilityProps | undefined;
}): AppContext {
  const env = input.env;
  const auth = requireActiveOrganization(input.props);
  return {
    auth: {
      isAuthenticated: true,
      orgId: auth.orgId,
      orgPermissions: auth.orgPermissions,
      orgRole: auth.orgRole,
      orgSlug: auth.orgSlug,
      sessionId: auth.sessionId,
      userId: auth.userId,
    } as AppContext["auth"],
    callableEnv: input.env as unknown as Record<string, unknown>,
    codemodeSession: env.CODEMODE_SESSION,
    // The ORPC capability runs after the original browser request has gone
    // away, so it cannot reuse request-local objects like `rawRequest`. It can,
    // however, reconstruct the durable app context from actual Worker bindings
    // plus the active organization captured into the provider props.
    config: {} as AppContext["config"],
    db: env.DB ? createD1Client(env.DB) : (undefined as never),
    doCatalog: env.DO_CATALOG ?? env.DB,
    log: createRequestLogger({
      method: "CODEMODE",
      path: "codemode://orpc-capability",
      requestId: crypto.randomUUID(),
    }),
    manifest,
    projectDurableObjectNamespace: env.PROJECT,
    projectHostnameBases: [],
    stream: env.STREAM,
  };
}

function requireActiveOrganization(props: ExampleCapabilityProps | undefined) {
  const activeOrganization = props?.activeOrganization;
  if (!activeOrganization) {
    throw new Error(
      "OrpcCapability requires activeOrganization props captured from the OS2 request context.",
    );
  }
  return activeOrganization;
}

function requireProviderProjectId(props: ExampleCapabilityProps | undefined) {
  const projectId = props?.projectId;
  if (!projectId) throw new Error("Codemode example capability requires ctx.props.projectId.");
  return projectId;
}
