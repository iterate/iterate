import { DurableObject, RpcTarget } from "cloudflare:workers";

import type {
  IterateAuthAccessTokenOrganizationClaim,
  IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";

type EventInput = {
  payload?: unknown;
  type: string;
};

type EventRecord = EventInput & {
  offset: string;
};

type RepoInfo = {
  slug: string;
};

type WorkspaceFile = {
  content: string;
  path: string;
};

type ProjectCreateInput = {
  id?: string;
  organization?: ProjectCreateOrganization;
  slug: string;
};

type ProjectCreateOrganization = {
  id?: string;
  slug?: string;
};

const PROJECT_REPO_SLUG = "iterate-config";
const PROJECT_WORKSPACE_SLUG = "main";

type AuthProps = {
  auth: CapabilityAuth;
};

type CapabilityAuth =
  | {
      type: "admin-api-secret";
    }
  | {
      organizations: IterateAuthAccessTokenOrganizationClaim[];
      projects: IterateAuthProjectClaim[];
      scopes: string[];
      sessionId?: string;
      type: "iterate-auth";
      userId: string;
    };

/**
 * Documentation sketch only.
 *
 * Goal: show the global capability hierarchy before designing context narrowing,
 * mounts, or fine-grained authorization.
 */
export class IterateCapability extends RpcTarget {
  constructor(private readonly input: { env: CapabilityEnv; props: AuthProps }) {
    super();
  }

  get projects() {
    return new ProjectsCapability({
      env: this.input.env,
      props: this.input.props,
    });
  }

  get streams() {
    return new StreamsCapability({
      env: this.input.env,
      props: this.input.props,
    });
  }

  get repos() {
    return new ReposCapability({
      env: this.input.env,
      props: this.input.props,
    });
  }

  get workspaces() {
    return new WorkspacesCapability({
      env: this.input.env,
      props: this.input.props,
    });
  }
}

export class ProjectsCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps;
    },
  ) {
    super();
  }

  create(input: ProjectCreateInput) {
    const organization = resolveProjectCreationOrganization(
      this.input.props.auth,
      input.organization,
    );
    const projectId = input.id ?? "proj_generated";
    // sketch only: a real implementation would persist the project record here
    void { organization, projectId, slug: input.slug };
    return new ProjectCapability({
      env: this.input.env,
      props: withAuth(this.input.props, { projectId }),
    });
  }

  get(projectIdOrSlug: string) {
    const projectId = projectIdOrSlug.startsWith("proj_")
      ? projectIdOrSlug
      : `proj_${projectIdOrSlug}`;
    assertCanAccessProject(this.input.props.auth, projectId);
    return new ProjectCapability({
      env: this.input.env,
      props: withAuth(this.input.props, { projectId }),
    });
  }

  list(): Array<{ id: string; slug: string }> {
    const projects = listProjectsFromD1();
    const scopedProjectIds = projectScopeIds(this.input.props.auth);
    if (scopedProjectIds === "*") return projects;
    return projects.filter((project) => scopedProjectIds.has(project.id));
  }
}

export class ProjectCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { projectId: string };
    },
  ) {
    super();
  }

  get stream() {
    return this.streams.get("/");
  }

  get streams() {
    return new ProjectStreamsCapability({
      env: this.input.env,
      props: {
        namespace: this.input.props.projectId,
        auth: this.input.props.auth,
      },
    });
  }

  get repo() {
    return this.repos.get({ slug: PROJECT_REPO_SLUG });
  }

  get repos() {
    return new ProjectReposCapability({
      env: this.input.env,
      props: {
        namespace: this.input.props.projectId,
        auth: this.input.props.auth,
      },
    });
  }

  get workspace() {
    return this.workspaces.get({ slug: PROJECT_WORKSPACE_SLUG });
  }

  get workspaces() {
    return new ProjectWorkspacesCapability({
      env: this.input.env,
      props: {
        namespace: this.input.props.projectId,
        auth: this.input.props.auth,
      },
    });
  }

  get worker() {
    return new ProjectWorkerCapability({
      env: this.input.env,
      props: {
        projectId: this.input.props.projectId,
        auth: this.input.props.auth,
      },
    });
  }

  egressFetch(request: Request) {
    return this.project().egressFetch(request);
  }

  fetch(request: Request) {
    return this.project().fetch(request);
  }

  describe() {
    return this.project().describe();
  }

  private project() {
    return this.input.env.PROJECT.getByName(this.input.props.projectId);
  }
}

export class StreamsCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps;
    },
  ) {
    super();
  }

  get(input: StreamAddressInput) {
    assertAdmin(this.input.props.auth);
    const { namespace, path } = parseStreamAddress(input);
    return new StreamCapability({
      env: this.input.env,
      props: withAuth(this.input.props, { namespace, path }),
    });
  }
}

export class ProjectStreamsCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { namespace: string };
    },
  ) {
    super();
  }

  get(input: string | { path: string }) {
    const path = typeof input === "string" ? input : input.path;
    return new StreamCapability({
      env: this.input.env,
      props: {
        auth: this.input.props.auth,
        namespace: this.input.props.namespace,
        path,
      },
    });
  }
}

export class StreamCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { namespace: string; path: string };
    },
  ) {
    super();
  }

  append(event: EventInput) {
    return this.stream().append(event);
  }

  describe() {
    return {
      namespace: this.input.props.namespace,
      path: this.input.props.path,
    };
  }

  read(input: { after?: string } = {}) {
    return this.stream().read(input);
  }

  subscribe(input: { after?: string } = {}) {
    return this.stream().subscribe(input);
  }

  private stream() {
    return this.input.env.STREAM.getByName(
      `${this.input.props.namespace}:${this.input.props.path}`,
    );
  }
}

export class ReposCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps;
    },
  ) {
    super();
  }

  create(input: { namespace: string; slug: string }) {
    assertAdmin(this.input.props.auth);
    return new RepoCapability({
      env: this.input.env,
      props: withAuth(this.input.props, input),
    });
  }

  get(input: { namespace: string; slug: string }) {
    assertAdmin(this.input.props.auth);
    return new RepoCapability({
      env: this.input.env,
      props: withAuth(this.input.props, input),
    });
  }

  list(_input: { namespace: string }) {
    assertAdmin(this.input.props.auth);
    // Reads /repos collection stream reduced state in the Repo Namespace.
    return [];
  }
}

export class ProjectReposCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { namespace: string };
    },
  ) {
    super();
  }

  create(input: { slug: string }) {
    return new RepoCapability({
      env: this.input.env,
      props: {
        auth: this.input.props.auth,
        namespace: this.input.props.namespace,
        slug: input.slug,
      },
    });
  }

  get(input: { slug: string } | string) {
    const slug = typeof input === "string" ? input : input.slug;
    return new RepoCapability({
      env: this.input.env,
      props: {
        auth: this.input.props.auth,
        namespace: this.input.props.namespace,
        slug,
      },
    });
  }

  list() {
    // Reads /repos collection stream reduced state in this Project's Repo Namespace.
    return [];
  }
}

export class RepoCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { namespace: string; slug: string };
    },
  ) {
    super();
  }

  describe() {
    return this.repo().describe();
  }

  private repo() {
    return this.input.env.REPO.getByName(`${this.input.props.namespace}:${this.input.props.slug}`);
  }
}

export class WorkspacesCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps;
    },
  ) {
    super();
  }

  create(input: { namespace: string; slug: string }) {
    assertAdmin(this.input.props.auth);
    return new WorkspaceCapability({
      env: this.input.env,
      props: withAuth(this.input.props, input),
    });
  }

  get(input: { namespace: string; slug: string }) {
    assertAdmin(this.input.props.auth);
    return new WorkspaceCapability({
      env: this.input.env,
      props: withAuth(this.input.props, input),
    });
  }

  list(_input: { namespace: string }) {
    assertAdmin(this.input.props.auth);
    // Reads /workspaces collection stream reduced state in the Workspace Namespace.
    return [];
  }
}

export class ProjectWorkspacesCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { namespace: string };
    },
  ) {
    super();
  }

  create(input: { slug: string }) {
    return new WorkspaceCapability({
      env: this.input.env,
      props: {
        auth: this.input.props.auth,
        namespace: this.input.props.namespace,
        slug: input.slug,
      },
    });
  }

  get(input: { slug: string } | string) {
    const slug = typeof input === "string" ? input : input.slug;
    return new WorkspaceCapability({
      env: this.input.env,
      props: {
        auth: this.input.props.auth,
        namespace: this.input.props.namespace,
        slug,
      },
    });
  }

  list() {
    // Reads /workspaces collection stream reduced state in this Project's Workspace Namespace.
    return [];
  }
}

export class WorkspaceCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { namespace: string; slug: string };
    },
  ) {
    super();
  }

  get git() {
    return new WorkspaceGitCapability(this.input);
  }

  describe() {
    return this.workspace().describe();
  }

  readFile(input: { path: string }) {
    return this.workspace().readFile(input);
  }

  writeFile(input: WorkspaceFile) {
    return this.workspace().writeFile(input);
  }

  private workspace() {
    return this.input.env.WORKSPACE.getByName(
      `${this.input.props.namespace}:${this.input.props.slug}`,
    );
  }
}

export class WorkspaceGitCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { namespace: string; slug: string };
    },
  ) {
    super();
  }

  add(input: { path: string }) {
    return this.workspace().gitAdd(input);
  }

  commit(input: { message: string }) {
    return this.workspace().gitCommit(input);
  }

  describe() {
    return {
      facet: "git",
      namespace: this.input.props.namespace,
      slug: this.input.props.slug,
    };
  }

  private workspace() {
    return this.input.env.WORKSPACE.getByName(
      `${this.input.props.namespace}:${this.input.props.slug}`,
    );
  }
}

export class ProjectWorkerCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: CapabilityEnv;
      props: AuthProps & { projectId: string };
    },
  ) {
    super();

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "then") return undefined;
        if (typeof prop === "symbol" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return (...args: unknown[]) =>
          target.project().callConfigWorkerFunction({
            args,
            functionName: prop,
          });
      },
    }) as ProjectWorkerCapability;
  }

  fetch(request: Request) {
    return this.project().fetch(request);
  }

  describe() {
    return {
      facet: "worker",
      projectId: this.input.props.projectId,
    };
  }

  private project() {
    return this.input.env.PROJECT.getByName(this.input.props.projectId);
  }
}

export class ProjectDurableObject extends DurableObject {
  // Durable Objects are trusted domain actors. They do not inspect caller auth
  // and they do not use RpcTarget capabilities internally. Capability adapters
  // are the authority membrane for untrusted callers.
  get stream() {
    return this.env.STREAM.getByName(`${this.address.projectId}:/`);
  }

  streamAt(path: string) {
    return this.env.STREAM.getByName(`${this.address.projectId}:${path}`);
  }

  get repo() {
    return this.env.REPO.getByName(`${this.address.projectId}:${PROJECT_REPO_SLUG}`);
  }

  repoBySlug(slug: string) {
    return this.env.REPO.getByName(`${this.address.projectId}:${slug}`);
  }

  get workspace() {
    return this.env.WORKSPACE.getByName(`${this.address.projectId}:${PROJECT_WORKSPACE_SLUG}`);
  }

  workspaceBySlug(slug: string) {
    return this.env.WORKSPACE.getByName(`${this.address.projectId}:${slug}`);
  }

  async appendProjectEvent(path: string, event: EventInput) {
    await this.streamAt(path).append({ event });
  }

  egressFetch(_request: Request): Promise<Response> {
    throw new Error("sketch only");
  }

  fetch(_request: Request): Promise<Response> {
    throw new Error("sketch only");
  }

  describe(): Promise<{ id: string; slug: string }> {
    throw new Error("sketch only");
  }

  callConfigWorkerFunction(_input: { args: unknown[]; functionName: string | symbol }) {
    throw new Error("sketch only");
  }

  private get address() {
    return { projectId: this.ctx.id.name! };
  }
}

export class StreamDurableObject extends DurableObject {
  get address() {
    const [namespace, path] = this.ctx.id.name!.split(/:(?=\/)/);
    return { namespace, path };
  }

  append(_event: EventInput): Promise<EventRecord> {
    throw new Error("sketch only");
  }

  read(_input: { after?: string }): Promise<EventRecord[]> {
    throw new Error("sketch only");
  }

  subscribe(_input: { after?: string }): Promise<ReadableStream<EventRecord>> {
    throw new Error("sketch only");
  }
}

export class RepoDurableObject extends DurableObject {
  get address() {
    const [namespace, slug] = this.ctx.id.name!.split(":", 2);
    return { namespace, slug };
  }

  describe(): Promise<RepoInfo> {
    throw new Error("sketch only");
  }
}

export class WorkspaceDurableObject extends DurableObject {
  get address() {
    const [namespace, slug] = this.ctx.id.name!.split(":", 2);
    return { namespace, slug };
  }

  describe(): Promise<{ namespace: string; slug: string }> {
    throw new Error("sketch only");
  }

  readFile(_input: { path: string }): Promise<WorkspaceFile> {
    throw new Error("sketch only");
  }

  writeFile(_input: WorkspaceFile): Promise<void> {
    throw new Error("sketch only");
  }

  gitAdd(_input: { path: string }): Promise<void> {
    throw new Error("sketch only");
  }

  gitCommit(_input: { message: string }): Promise<void> {
    throw new Error("sketch only");
  }
}

type StreamAddressInput = { namespace: string; path: string } | `${string}:/${string}`;

type CapabilityEnv = {
  PROJECT: DurableObjectNamespace<ProjectDurableObject>;
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDurableObject>;
};

function resolveProjectCreationOrganization(
  auth: CapabilityAuth,
  organization: ProjectCreateOrganization | undefined,
): ProjectCreateOrganization | undefined {
  if (auth.type === "admin-api-secret") return organization;

  if (!organization) return auth.organizations[0];

  const allowed = auth.organizations.some((candidate) => {
    return (
      (organization.id !== undefined && candidate.id === organization.id) ||
      (organization.slug !== undefined && candidate.slug === organization.slug)
    );
  });
  if (allowed) return organization;

  throw new Error("Project creation requires membership in the target organization");
}

function withAuth<TProps extends object>(props: AuthProps, childProps: TProps): AuthProps & TProps {
  return {
    ...childProps,
    auth: props.auth,
  };
}

function assertCanAccessProject(auth: CapabilityAuth, projectId: string) {
  if (canAccessProject(auth, projectId)) return;
  throw new Error(`Missing project scope for ${projectId}`);
}

function assertAdmin(auth: CapabilityAuth) {
  if (auth.type === "admin-api-secret") return;
  throw new Error("Admin API Secret authority is required");
}

function canAccessProject(auth: CapabilityAuth, projectId: string) {
  if (auth.type === "admin-api-secret") return true;
  return auth.projects.some((project) => project.id === projectId);
}

function projectScopeIds(auth: CapabilityAuth): "*" | Set<string> {
  if (auth.type === "admin-api-secret") return "*";
  return new Set(auth.projects.map((project) => project.id));
}

function listProjectsFromD1(): Array<{ id: string; slug: string }> {
  return [
    { id: "proj_alpha", slug: "alpha" },
    { id: "proj_beta", slug: "beta" },
  ];
}

function parseStreamAddress(input: StreamAddressInput) {
  if (typeof input !== "string") return input;
  const [namespace, path] = input.split(/:(?=\/)/);
  if (!namespace || !path) throw new Error(`Invalid stream address: ${input}`);
  return { namespace, path };
}
