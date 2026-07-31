import { RpcTarget } from "cloudflare:workers";

type TasksAppOptions = {
  auth: { policy: "project-member" };
  proxy: {
    origin: string;
    originOverrideKvKey: string;
  };
};

export type TasksLinkInput = {
  /** Absolute /workspaces/** stream path of the workspace the board renders. */
  workspace: string;
  /** Absolute /repos/** path of the repo whose task files the board shows. */
  repo: string;
  /** Repo-relative task file to open (a .md file under a `tasks/` folder). */
  task?: string;
};

type TasksProject = {
  [Symbol.dispose](): void;
  appUrl(appSlug: string): Promise<string>;
  auth: {
    get(policy: { policy: "project-member" }): {
      fetch(request: Request): Promise<Response | null>;
    };
  };
  kv: {
    get(key: string): Promise<unknown>;
  };
};

type TasksEnv = { ITX: { get(): Promise<TasksProject> } };

/** Project-side capability exposed by config workers as `itx.worker.tasks`. */
export class TasksAppRpcTarget extends RpcTarget {
  readonly #env: TasksEnv;

  constructor(env: TasksEnv) {
    super();
    this.#env = env;
  }

  /** Build a board URL for one workspace's task files under one repo. */
  async link(input: TasksLinkInput): Promise<string> {
    // Same validation the board applies when it opens, so a minted link can
    // only address a workspace/repo/task the board UI will accept.
    const workspace = requireWorkspacePath(input.workspace);
    const repo = requireRepoPath(input.repo);
    const task = input.task === undefined ? undefined : requireTaskPath(input.task);
    const itx = await this.#env.ITX.get();
    try {
      const url = new URL(await itx.appUrl("tasks"));
      url.pathname = "/w";
      url.searchParams.set("workspace", workspace);
      url.searchParams.set("repo", repo);
      if (task !== undefined) url.searchParams.set("task", task);
      return url.href;
    } finally {
      itx[Symbol.dispose]();
    }
  }
}

export const TasksApp = {
  create(env: TasksEnv, options: TasksAppOptions) {
    const configuredOrigin = parseHttpsOrigin(options.proxy.origin, "Tasks app proxy origin");
    return {
      rpc: new TasksAppRpcTarget(env),
      async fetch(request: Request): Promise<Response> {
        const itx = await env.ITX.get();
        try {
          const denied = await itx.auth.get(options.auth).fetch(request);
          if (denied) return denied;
          const override = await itx.kv.get(options.proxy.originOverrideKvKey);
          let origin = configuredOrigin;
          if (override) {
            const description = `Tasks app proxy override from "${options.proxy.originOverrideKvKey}"`;
            if (typeof override !== "string") {
              throw new Error(
                `${description} must be one complete HTTPS origin: ${JSON.stringify(override)}`,
              );
            }
            origin = parseHttpsOrigin(override, description);
          }
          const target = new URL(request.url);
          target.protocol = origin.protocol;
          target.host = origin.host;
          const forwarded = new Request(target, request);
          return await fetch(new Request(forwarded, { redirect: "manual" }));
        } finally {
          itx[Symbol.dispose]();
        }
      },
    };
  },
};

export function requireWorkspacePath(value: string): string {
  if (!value.startsWith("/workspaces/")) {
    throw new Error(`invalid workspace path: ${JSON.stringify(value)}`);
  }
  return requireCanonicalPath(value, "workspace path");
}

/** A board's repo path is a fully qualified /repos/** mount path — the SAME
 * rule the board applies on open (normalizeRepoPath), so a minted link can
 * never carry a repo the route would reject. */
export function requireRepoPath(value: string): string {
  const path = requireCanonicalPath(value, "repo path");
  const segments = path.startsWith("/repos/") ? path.slice(1).split("/") : [];
  if (
    segments.length < 2 ||
    segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    throw new Error(`repo path must name a repo under "/repos/": ${JSON.stringify(value)}`);
  }
  return path;
}

/** A task path is repo-relative: a Markdown file below a `tasks/` folder. */
export function requireTaskPath(value: string): string {
  const path = requireCanonicalPath(value, "task path");
  if (path.startsWith("/")) {
    throw new Error(`task path must be repo-relative: ${JSON.stringify(value)}`);
  }
  const segments = path.split("/");
  if (!/\.(?:md|markdown)$/i.test(segments.at(-1) ?? "") || !segments.includes("tasks")) {
    throw new Error(
      `task path must be a .md file below a "tasks" folder: ${JSON.stringify(value)}`,
    );
  }
  return path;
}

function requireCanonicalPath(value: string, description: string): string {
  const segments = (value.startsWith("/") ? value.slice(1) : value).split("/");
  if (
    value.length > 2048 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.endsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid ${description}: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseHttpsOrigin(value: string, description: string): URL {
  const invalidMessage = `${description} must be one complete HTTPS origin: ${value}`;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(invalidMessage);
  }
  if (origin.protocol !== "https:" || origin.origin !== value) throw new Error(invalidMessage);
  return origin;
}
