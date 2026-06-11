import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  AgentDurableObject,
  type CloneProjectRepoInput,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import type { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";

const AGENT_PROJECT_REPO_DIR = "/project";
const MOCK_ARTIFACT_REMOTE_BASE = "https://artifacts.example.test/";
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
    return `${MOCK_ARTIFACT_REMOTE_BASE}${this.artifactName}.git`;
  }

  async createToken(scope: "read" | "write", ttlSeconds: number) {
    return {
      expiresAt: new Date(Date.UTC(2036, 0, 1)).toISOString(),
      plaintext: `mock-${scope}-${ttlSeconds}-${this.artifactName}?expires=2082758400`,
    };
  }

  async fork(name: string) {
    const repo = new MockArtifactRepo(name);
    mockArtifactRepos.set(name, repo);
    return repo;
  }
}

export class MockArtifactAgentDurableObject extends AgentDurableObject {
  protected override async cloneProjectRepo(input: CloneProjectRepoInput) {
    if (!input.repo.remote.startsWith(MOCK_ARTIFACT_REMOTE_BASE)) {
      await super.cloneProjectRepo(input);
      return;
    }

    const state = await input.workspace.cloudflareShellState();
    await prepareMockProjectRepoWorkspace({
      git: input.git,
      writeFile: readWorkspaceStateMethod({ method: "writeFile", state }),
    });
  }
}

mockArtifactRepos.set("iterate-config-base", new MockArtifactRepo("iterate-config-base"));

async function prepareMockProjectRepoWorkspace(input: {
  git: Pick<
    Awaited<ReturnType<WorkspaceDurableObject["cloudflareShellGit"]>>,
    "add" | "commit" | "init"
  >;
  writeFile(...args: unknown[]): Promise<unknown>;
}) {
  await input.writeFile(`${AGENT_PROJECT_REPO_DIR}/iterate.config.jsonc`, '{\n  "version": 1\n}\n');
  await input.git.init({ dir: AGENT_PROJECT_REPO_DIR, defaultBranch: "main" });
  await input.git.add({ dir: AGENT_PROJECT_REPO_DIR, filepath: "iterate.config.jsonc" });
  await input.git.commit({
    dir: AGENT_PROJECT_REPO_DIR,
    message: "Seed iterate config",
    author: {
      name: "Iterate",
      email: "support@iterate.com",
    },
  });
}

function readWorkspaceStateMethod<
  K extends keyof Awaited<ReturnType<WorkspaceDurableObject["cloudflareShellState"]>>,
>(input: {
  method: K;
  state: Awaited<ReturnType<WorkspaceDurableObject["cloudflareShellState"]>>;
}) {
  const method = input.state[input.method];
  if (typeof method !== "function") {
    throw new Error(`Workspace state does not implement ${input.method}.`);
  }
  return method;
}
