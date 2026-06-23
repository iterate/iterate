import { DurableObject } from "cloudflare:workers";
import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import type { Repo, StreamEvent } from "../../../types-and-schemas.ts";
import { hashString, type ResolvedWorkerSource } from "../dynamic-workers/dynamic-worker-loader.ts";
import { parseDurableObjectName } from "../durable-object-names.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.ts";
import { RepoProcessor, RepoProcessorContract } from "./repo-processor.ts";

const REPO_DEFAULT_BRANCH = "main";
const REPO_WRITE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const REPO_DIR = "/repo";

type InternalStreamWriter = {
  append(input: unknown): Promise<unknown>;
  findEventSummary(input: unknown): Promise<Pick<StreamEvent, "createdAt" | "offset"> | undefined>;
};

export class RepoDurableObject extends DurableObject<Env> implements Repo {
  readonly #name = parseDurableObjectName(this.ctx.id.name!);
  readonly #host = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  #streamWriter(): InternalStreamWriter {
    return this.#stream as unknown as InternalStreamWriter;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host.add(RepoProcessorContract.slug, (deps) => new RepoProcessor(deps));
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#host.requestStreamSubscription(args);
  }

  async getWorkerSource(args: { path: string }): Promise<ResolvedWorkerSource> {
    const repo = await this.repoGitAccess();
    const tree = await readRepoModules({
      branch: repo.defaultBranch,
      remote: repo.remote,
      token: repo.token,
    });

    if (!(args.path in tree.modules)) {
      throw new Error(`repo ${this.#name.path} does not contain ${args.path}`);
    }

    return {
      cacheKey: hashString(`${tree.commitOid}:${args.path}`),
      mainModule: args.path,
      modules: tree.modules,
    };
  }

  async create(): Promise<StreamEvent> {
    const existing = await this.createdEvent();
    if (existing) return existing;

    await this.#streamWriter().append({
      event: {
        type: "events.iterate.com/repo/create-requested",
        payload: {},
      },
    });

    const artifactName = this.artifactName();
    const payload = (await this.artifactExists(artifactName))
      ? {
          artifactName,
          defaultBranch: REPO_DEFAULT_BRANCH,
          remote: this.artifactRemote(artifactName),
        }
      : await this.createArtifactRepo({});
    const event = await this.#streamWriter().append({
      event: {
        type: "events.iterate.com/repo/created",
        idempotencyKey: `repo-created:${this.#name.projectId}:${this.#name.path}`,
        payload,
      },
    });
    return event as StreamEvent;
  }

  async ensureCreated(): Promise<void> {
    await this.create();
  }

  whoami(): string {
    return `repo ${this.#name.projectId}:${this.#name.path}`;
  }

  private async createArtifactRepo(input: Record<string, unknown>) {
    const artifactName = this.artifactName();
    await this.getOrCreateArtifact(artifactName);
    const defaultBranch = REPO_DEFAULT_BRANCH;
    const remote = this.artifactRemote(artifactName);
    const token = await artifactToken(this.requireArtifacts(), artifactName);

    await seedArtifactRepo({
      branch: defaultBranch,
      files: PROJECT_REPO_INITIAL_FILES,
      remote,
      token,
    });

    return {
      artifactName,
      defaultBranch,
      remote,
      ...input,
    };
  }

  private async repoGitAccess() {
    const artifactName = this.artifactName();
    const artifacts = this.requireArtifacts();
    return {
      defaultBranch: REPO_DEFAULT_BRANCH,
      remote: this.artifactRemote(artifactName),
      token: await artifactToken(artifacts, artifactName),
    };
  }

  private async getOrCreateArtifact(name: string) {
    try {
      return await this.requireArtifacts().create(name, {
        setDefaultBranch: REPO_DEFAULT_BRANCH,
      });
    } catch {
      return await this.requireArtifacts().get(name);
    }
  }

  private async artifactExists(name: string): Promise<boolean> {
    try {
      await this.requireArtifacts().get(name);
      return true;
    } catch {
      return false;
    }
  }

  private async createdEvent(): Promise<StreamEvent | undefined> {
    const summary = await this.#streamWriter().findEventSummary({
      type: "events.iterate.com/repo/created",
    });
    if (!summary) return undefined;
    const artifactName = this.artifactName();
    return {
      ...summary,
      payload: {
        artifactName,
        defaultBranch: REPO_DEFAULT_BRANCH,
        remote: this.artifactRemote(artifactName),
      },
      type: "events.iterate.com/repo/created",
    };
  }

  private requireArtifacts(): Artifacts {
    return this.env.ARTIFACTS;
  }

  private artifactName() {
    return `repo-${hexEncode(`${this.#name.projectId}:${this.#name.path}`)}`;
  }

  private artifactRemote(artifactName: string) {
    return `https://${this.env.ARTIFACTS_ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.ARTIFACTS_NAMESPACE}/${artifactName}.git`;
  }
}

async function artifactToken(artifacts: Artifacts, name: string) {
  const repo = await artifacts.get(name);
  const { plaintext } = await repo.createToken("write", REPO_WRITE_TOKEN_TTL_SECONDS);
  return stripArtifactTokenQuery(plaintext);
}

async function seedArtifactRepo(input: {
  branch: string;
  files: Array<{ content: string; path: string }>;
  remote: string;
  token: string;
}) {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  const credentials = { password: input.token, username: "x" };

  try {
    await git.clone({
      branch: input.branch,
      depth: 1,
      singleBranch: true,
      url: input.remote,
      ...credentials,
    });
  } catch {
    await git.init({ defaultBranch: input.branch });
    await git.remote({
      add: { name: "origin", url: input.remote },
    });
  }

  for (const file of input.files) {
    const dir = `${REPO_DIR}/${file.path}`.replace(/\/[^/]+$/, "");
    if (dir !== REPO_DIR && !(await filesystem.exists(dir))) {
      await filesystem.mkdir(dir, { recursive: true });
    }
    await filesystem.writeFile(`${REPO_DIR}/${file.path}`, file.content);
    await git.add({ filepath: file.path });
  }

  try {
    await git.commit({
      author: { email: "support@iterate.com", name: "Iterate" },
      message: "Seed minimal ITX project worker",
    });
    await ensureBranchRef({ branch: input.branch, git });
  } catch (error) {
    if (!String(error).match(/nothing to commit|no changes/i)) throw error;
  }

  const pushed = await git.push({
    force: true,
    ref: input.branch,
    remote: "origin",
    ...credentials,
  });
  if (!pushed.ok) {
    throw new Error(`Failed to push ${input.branch}: ${JSON.stringify(pushed.refs)}`);
  }
}

async function readRepoModules(input: { branch: string; remote: string; token: string }) {
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, REPO_DIR);
  await git.clone({
    branch: input.branch,
    depth: 1,
    singleBranch: true,
    url: input.remote,
    username: "x",
    password: input.token,
  });

  const [head] = await git.log({ depth: 1 });
  if (!head) throw new Error("Repo has no commits.");

  const modules: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await filesystem.readdirWithFileTypes(dir)) {
      if (dir === REPO_DIR && entry.name === ".git") continue;
      const entryPath = `${dir}/${entry.name}`;
      if (entry.type === "directory") {
        await walk(entryPath);
      } else if (entryPath.endsWith(".js")) {
        modules[entryPath.slice(REPO_DIR.length + 1)] = await filesystem.readFile(entryPath);
      }
    }
  };
  await walk(REPO_DIR);

  return { commitOid: head.oid, modules };
}

function stripArtifactTokenQuery(token: string) {
  return token.split("?expires=")[0] ?? token;
}

async function ensureBranchRef(input: { branch: string; git: ReturnType<typeof createGit> }) {
  try {
    await input.git.branch({ name: input.branch });
  } catch (error) {
    if (!String(error).match(/already exists/i)) throw error;
  }
}

function hexEncode(value: string) {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
