import { WorkerEntrypoint } from "cloudflare:workers";
import { RpcTarget } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";

export { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
export { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AiCapability, OrpcCapability } from "~/domains/codemode/example-capabilities.ts";
export { FetchCapability } from "~/domains/codemode/fetch-capability.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";

const mockArtifactRepos = new Map<string, MockArtifactRepo>();

export class MockArtifactsBinding extends WorkerEntrypoint {
  async create(name: string) {
    if (mockArtifactRepos.has(name)) {
      throw new Error(`Artifact repo ${name} already exists.`);
    }

    const repo = new MockArtifactRepo(name);
    mockArtifactRepos.set(name, repo);
    return repo;
  }

  async get(name: string) {
    const repo = mockArtifactRepos.get(name);
    if (!repo) {
      throw new Error(`Artifact repo ${name} not found.`);
    }

    return repo;
  }
}

export class MockArtifactRepo extends RpcTarget {
  readonly artifactName: string;

  constructor(name: string) {
    super();
    this.artifactName = name;
  }

  defaultBranch() {
    return "main";
  }

  remote() {
    return `https://artifacts.example.test/${this.artifactName}.git`;
  }

  async createToken(scope: "read" | "write", ttlSeconds: number) {
    return {
      expiresAt: new Date(Date.UTC(2036, 0, 1)).toISOString(),
      plaintext: `mock-${scope}-${ttlSeconds}-${this.artifactName}`,
    };
  }

  async fork(name: string) {
    const repo = new MockArtifactRepo(name);
    mockArtifactRepos.set(name, repo);
    return repo;
  }
}

mockArtifactRepos.set("iterate-config-base", new MockArtifactRepo("iterate-config-base"));

type ToolFunctionInput = {
  codemodeSessionCapability: Parameters<
    typeof createCodemodeContext
  >[0]["codemodeSessionCapability"];
  path: string[];
  args: Record<string, unknown>[];
};

export class ProviderA extends WorkerEntrypoint {
  async executeCodemodeFunctionCall(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === "compose.exclaimViaB") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const [request] = input.args;
      const result = (await ctx.providerB.text.exclaim({
        value: request?.value,
      })) as { value: string };

      return {
        provider: "provider-a",
        route: "codemode-session-capability",
        toolFunction: "compose.exclaimViaB",
        value: result.value,
      };
    }

    if (path === "math.add") {
      const [request] = input.args;
      return {
        provider: "provider-a",
        toolFunction: "math.add",
        value: Number(request?.left) + Number(request?.right),
      };
    }

    if (path === "text.upper") {
      const [request] = input.args;
      return {
        provider: "provider-a",
        toolFunction: "text.upper",
        value: String(request?.value).toUpperCase(),
      };
    }

    throw new Error(`Provider A does not implement ${path}`);
  }
}

export class ProviderB extends WorkerEntrypoint {
  async executeCodemodeFunctionCall(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === "compose.addThenUpper") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const [request] = input.args;
      const added = (await ctx.providerA.math.add({
        left: request?.left,
        right: request?.right,
      })) as { value: number };
      const upper = (await ctx.providerA.text.upper({
        value: `sum ${added.value}`,
      })) as { value: string };

      return {
        provider: "provider-b",
        route: "codemode-session-capability",
        toolFunction: "compose.addThenUpper",
        value: upper.value,
      };
    }

    if (path === "text.exclaim") {
      const [request] = input.args;
      return {
        provider: "provider-b",
        toolFunction: "text.exclaim",
        value: `${String(request?.value).toUpperCase()}!`,
      };
    }

    throw new Error(`Provider B does not implement ${path}`);
  }
}

export default {
  fetch() {
    return new Response("codemode session test worker");
  },
};
