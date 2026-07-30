import { RpcTarget } from "cloudflare:workers";

export type DocsAppOptions = {
  auth: { policy: "project-member" };
  proxy: {
    origin: string;
    originOverrideKvKey: string;
  };
};

export type DocsLinkInput = {
  path: string;
  workspace: string;
};

type DocsProject = {
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

type DocsEnv = { ITX: { get(): Promise<DocsProject> } };

/** Project-side capability exposed by config workers as `itx.worker.docs`. */
export class DocsAppRpcTarget extends RpcTarget {
  readonly #env: DocsEnv;

  constructor(env: DocsEnv) {
    super();
    this.#env = env;
  }

  /** Build a review URL for one Markdown or HTML workspace file. */
  async link(input: DocsLinkInput): Promise<string> {
    if (!input.workspace.startsWith("/workspaces/") || !input.path.startsWith("/")) {
      throw new Error("Docs links require absolute workspace and document paths.");
    }
    const itx = await this.#env.ITX.get();
    try {
      const url = new URL(await itx.appUrl("docs"));
      url.searchParams.set("workspace", input.workspace);
      url.searchParams.set("path", input.path);
      return url.href;
    } finally {
      itx[Symbol.dispose]();
    }
  }
}

export const DocsApp = {
  create(env: DocsEnv, options: DocsAppOptions) {
    const configuredOrigin = parseHttpsOrigin(options.proxy.origin, "Docs app proxy origin");
    return {
      rpc: new DocsAppRpcTarget(env),
      async fetch(request: Request): Promise<Response> {
        const itx = await env.ITX.get();
        try {
          const denied = await itx.auth.get(options.auth).fetch(request);
          if (denied !== null) return denied;
          const override = await itx.kv.get(options.proxy.originOverrideKvKey);
          const origin =
            override === null || override === undefined || override === ""
              ? configuredOrigin
              : parseOverride(override, options.proxy.originOverrideKvKey);
          const target = new URL(request.url);
          target.protocol = origin.protocol;
          target.host = origin.host;
          return fetch(new Request(new Request(target, request), { redirect: "manual" }));
        } finally {
          itx[Symbol.dispose]();
        }
      },
    };
  },
};

function parseOverride(value: unknown, key: string): URL {
  const description = `Docs app proxy override from "${key}"`;
  if (typeof value !== "string") {
    throw new Error(`${description} must be one complete HTTPS origin: ${JSON.stringify(value)}`);
  }
  return parseHttpsOrigin(value, description);
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
