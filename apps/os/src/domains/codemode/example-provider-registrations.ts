import type { Callable } from "@iterate-com/shared/callable/types.ts";
import type { ToolProviderRegistration } from "~/domains/codemode/stream-processors/codemode/contract.ts";

type SerializableValue =
  | null
  | boolean
  | number
  | string
  | SerializableValue[]
  | { [key: string]: SerializableValue };

export function createExampleRpcProviderRegistration(input: {
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
        exportName: input.exportName,
        projectId: input.projectId,
      }),
    },
    path: input.path,
  };
}

export function createExampleCapabilityProviders(input: {
  projectId: string;
}): ToolProviderRegistration[] {
  return [
    createExampleRpcProviderRegistration({
      exportName: "AiCapability",
      instructions: "Use ctx.ai.run(model, input) to call the Workers AI binding.",
      path: ["ai"],
      projectId: input.projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "ReposCapability",
      instructions:
        "Use ctx.repos.create({ slug }) to create a Repo, ctx.repos.get({ slug }).getInfo() to inspect one, ctx.repos.ensureIterateConfigInfo({ projectSlug }) to create or inspect the iterate-config Repo, and ctx.repos.list({}) to list Repos.",
      path: ["repos"],
      projectId: input.projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "AgentCapability",
      instructions:
        "Use ctx.agents.create() to get a promise-pipelineable subagent handle, e.g. await ctx.agents.create().doThing(args).",
      path: ["agents", "create"],
      projectId: input.projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "OrpcCapability",
      instructions:
        "Use ctx.os.listProcedures() and project-scoped OS APIs such as ctx.os.streams.list({}).",
      path: ["os"],
      projectId: input.projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "SlackCapability",
      instructions:
        "Use ctx.slack.<Slack Web API method path>(args), for example ctx.slack.chat.postMessage({ channel, thread_ts, text }). Slack agents MUST respond on the same thread_ts that received the message; otherwise they will not receive responses from that thread. Unless explicitly required, always include thread_ts in Slack replies. Do not post to Slack unless the bot was explicitly mentioned, a user directly asks or instructs you, or the surrounding thread context clearly calls for agent action.",
      path: ["slack"],
      projectId: input.projectId,
    }),
  ];
}

function createExampleCapabilityCallable(input: {
  exportName: string;
  projectId?: string;
}): Callable {
  const props: { [key: string]: SerializableValue } = {
    ...(input.projectId == null ? {} : { projectId: input.projectId }),
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
