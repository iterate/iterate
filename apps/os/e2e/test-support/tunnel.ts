import http from "node:http";
import { createCaptunTunnel, type CaptunTunnel } from "captun";

export type TunnelFetchHandler = (request: Request) => Response | Promise<Response>;

export type TunnelHandle = {
  close(): Promise<void>;
  local: boolean;
  url: string;
  [Symbol.asyncDispose](): Promise<void>;
};

export type TunnelOptions = {
  fetch: TunnelFetchHandler;
  name?: string;
  path?: string;
};

export async function withTunnel(options: TunnelOptions): Promise<TunnelHandle> {
  const path = options.path ?? "";
  if (e2eTargetNeedsPublicTunnel()) {
    return await withPublicCaptunTunnel({ ...options, path });
  }

  return await withLoopbackServer(options.fetch, path);
}

function e2eTargetNeedsPublicTunnel(): boolean {
  const raw = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!raw) return false;

  const url = new URL(raw);
  return !(
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname.endsWith(".localhost")
  );
}

function captunToken(): string {
  const token = process.env.CAPTUN_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "CAPTUN_TOKEN is required for tunnel-backed OS e2e fixtures. Run through Doppler preview/dev config or export CAPTUN_TOKEN.",
    );
  }
  return token;
}

async function withPublicCaptunTunnel(
  options: Required<Pick<TunnelOptions, "fetch" | "path">> & {
    name?: string;
  },
): Promise<TunnelHandle> {
  let tunnel: CaptunTunnel;
  try {
    tunnel = await createCaptunTunnel({
      fetch: options.fetch,
      gateway: process.env.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com",
      name: options.name,
      token: captunToken(),
    });
  } catch (error) {
    throw new Error(`Failed to create captun e2e fixture tunnel: ${String(error)}`, {
      cause: error,
    });
  }

  const close = async () => {
    tunnel[Symbol.dispose]();
  };

  return {
    close,
    local: false,
    url: tunnelUrl(tunnel.url, options.path),
    [Symbol.asyncDispose]: close,
  };
}

function tunnelUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  const href = url.toString();
  return path === "" ? href.replace(/\/$/, "") : href;
}

function withLoopbackServer(handler: TunnelFetchHandler, path: string): Promise<TunnelHandle> {
  let baseUrl = "";
  const server = http.createServer((req, res) => {
    handleLoopbackRequest({ baseUrl, handler, req, res });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      baseUrl = `http://127.0.0.1:${port}`;
      const close = () =>
        new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => (error ? closeReject(error) : closeResolve()));
        });
      resolve({
        close,
        local: true,
        url: `${baseUrl}${path}`,
        [Symbol.asyncDispose]: close,
      });
    });
  });
}

function handleLoopbackRequest(input: {
  baseUrl: string;
  handler: TunnelFetchHandler;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}) {
  const requestUrl = new URL(input.req.url ?? "/", input.baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value) {
      headers.set(key, value);
    }
  }

  const chunks: Buffer[] = [];
  input.req.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  input.req.on("end", () => {
    void (async () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(requestUrl, {
        body,
        headers,
        method: input.req.method ?? "GET",
      });
      const response = await input.handler(request);
      input.res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        input.res.end();
        return;
      }
      input.res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error) => {
      input.res.writeHead(500, { "content-type": "application/json" });
      input.res.end(JSON.stringify({ error: String(error) }));
    });
  });
}
