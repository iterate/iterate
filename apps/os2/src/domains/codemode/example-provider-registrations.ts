import type { Callable } from "@iterate-com/shared/callable/types.ts";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";

type SerializableValue =
  | null
  | boolean
  | number
  | string
  | SerializableValue[]
  | { [key: string]: SerializableValue };

export function createExampleRpcProviderRegistration(input: {
  activeOrganization?: ActiveOrganizationAuth;
  exportName: string;
  instructions: string;
  path: string[];
  projectId?: string;
}): ToolProviderRegistration {
  return {
    instructions: input.instructions,
    invocation: {
      kind: "rpc",
      callable: createExampleCapabilityCallable({
        activeOrganization: input.activeOrganization,
        exportName: input.exportName,
        projectId: input.projectId,
      }),
    },
    path: input.path,
  };
}

export function createWorkspaceProviderRegistration(input: {
  instructions: string;
  name: string;
  path: string[];
}): ToolProviderRegistration {
  return {
    instructions: input.instructions,
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "WORKSPACE",
          durableObject: { name: input.name },
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
    path: input.path,
  };
}

export function createExampleCapabilityProviders(input: {
  activeOrganization?: ActiveOrganizationAuth;
  projectId: string;
}): ToolProviderRegistration[] {
  return [
    createExampleRpcProviderRegistration({
      exportName: "AiCapability",
      activeOrganization: input.activeOrganization,
      instructions: "Use ctx.ai.run(model, input) to call the Workers AI binding.",
      path: ["ai"],
      projectId: input.projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "RepoCapability",
      activeOrganization: input.activeOrganization,
      instructions: "Use ctx.repos.get({ slug }) to get a repo handle.",
      path: ["repos"],
      projectId: input.projectId,
    }),
    createWorkspaceProviderRegistration({
      instructions: "Use ctx.workspace.proofOfConcept(args) for the current workspace.",
      name: input.projectId,
      path: ["workspace"],
    }),
    createExampleRpcProviderRegistration({
      exportName: "AgentCapability",
      activeOrganization: input.activeOrganization,
      instructions:
        "Use ctx.agents.create() to get a promise-pipelineable subagent handle, e.g. await ctx.agents.create().doThing(args).",
      path: ["agents", "create"],
      projectId: input.projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "OrpcCapability",
      activeOrganization: input.activeOrganization,
      instructions:
        "Use ctx.os.listProcedures() and project-scoped OS2 APIs such as ctx.os.streams.list({}).",
      path: ["os"],
      projectId: input.projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "SlackCapability",
      activeOrganization: input.activeOrganization,
      instructions:
        "Use ctx.slack.<Slack Web API method path>(args), for example ctx.slack.chat.postMessage({ channel, text }).",
      path: ["slack"],
      projectId: input.projectId,
    }),
  ];
}

function createExampleCapabilityCallable(input: {
  activeOrganization?: ActiveOrganizationAuth;
  exportName: string;
  projectId?: string;
}): Callable {
  const props: { [key: string]: SerializableValue } = {
    ...(input.projectId == null ? {} : { projectId: input.projectId }),
    ...(input.activeOrganization == null
      ? {}
      : { activeOrganization: activeOrganizationToSerializable(input.activeOrganization) }),
  };
  return {
    type: "workers-rpc",
    via: {
      type: "loopback-binding",
      bindingType: "service",
      exportName: input.exportName,
      // Loopback WorkerEntrypoint props are runtime authority, not persisted
      // configuration. The descriptor is durable JSON; CodemodeSession supplies
      // `ctx.exports` when dispatching it, and Cloudflare then creates the
      // per-project binding from this props object.
      ...(Object.keys(props).length === 0 ? {} : { props }),
    },
    rpcMethod: "executeCodemodeFunctionCall",
    argsMode: "object",
  };
}

function activeOrganizationToSerializable(activeOrganization: ActiveOrganizationAuth): {
  [key: string]: SerializableValue;
} {
  return {
    orgId: activeOrganization.orgId,
    orgPermissions: activeOrganization.orgPermissions,
    orgRole: activeOrganization.orgRole,
    orgSlug: activeOrganization.orgSlug,
    sessionId: activeOrganization.sessionId,
    userId: activeOrganization.userId,
  };
}
