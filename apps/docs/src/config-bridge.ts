export type DocsAppOptions = {
  auth: { policy: "project-member" };
  proxy: {
    origin: string;
    originOverrideKvKey: string;
  };
};

type DocsProject = {
  [Symbol.dispose](): void;
  auth: {
    get(policy: { policy: "project-member" }): {
      fetch(request: Request): Promise<Response | null>;
    };
  };
  kv: {
    get(key: string): Promise<unknown>;
  };
};

export const DocsApp = {
  create(env: { ITX: { get(): Promise<DocsProject> } }, options: DocsAppOptions) {
    const configuredOrigin = parseHttpsOrigin(options.proxy.origin, "Docs app proxy origin");
    return {
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
