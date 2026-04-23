import { fileURLToPath } from "node:url";
import type { StreamPath } from "@iterate-com/events-contract";
import {
  useCloudflareTunnel,
  useCloudflareTunnelLease,
  useDevServer,
} from "@iterate-com/shared/test-helpers";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface LocalDevServerHandle {
  publicUrl: string;
  callbackUrl: string;
  baseUrl: string;
  streamPath: StreamPath;
}

export async function createLocalDevServer(opts: {
  egressProxy?: string;
  eventsBaseUrl: string;
  eventsProjectSlug: string;
  executionSuffix: string;
  streamPath: StreamPath;
  instancePrefix?: string;
}): Promise<LocalDevServerHandle & AsyncDisposable> {
  const disposables: AsyncDisposable[] = [];
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const d of disposables.reverse()) {
      await d[Symbol.asyncDispose]();
    }
  };

  try {
    const tunnelLease = await useCloudflareTunnelLease({});
    disposables.push(tunnelLease);

    const env: Record<string, string> = {
      ...stripInheritedAppConfig(process.env),
      APP_CONFIG_EVENTS_BASE_URL: opts.eventsBaseUrl,
      APP_CONFIG_EVENTS_PROJECT_SLUG: opts.eventsProjectSlug,
    };
    if (opts.egressProxy) {
      env.APP_CONFIG_EXTERNAL_EGRESS_PROXY = opts.egressProxy;
    }

    const devServer = await useDevServer({
      cwd: appRoot,
      command: "pnpm",
      args: ["exec", "tsx", "./alchemy.run.ts"],
      port: tunnelLease.localPort,
      env,
    });
    disposables.push(devServer);
    console.info(`[e2e] Agents dev server: ${devServer.baseUrl}`);

    const tunnel = await useCloudflareTunnel({
      token: tunnelLease.tunnelToken,
      publicUrl: tunnelLease.publicUrl,
    });
    disposables.push(tunnel);

    const prefix = opts.instancePrefix ?? "e2e";
    const agentInstance = `${prefix}-${opts.executionSuffix}`;
    const callbackUrl = toWssAgentWebsocketUrl(tunnel.publicUrl, agentInstance);

    return {
      publicUrl: tunnel.publicUrl,
      callbackUrl,
      baseUrl: devServer.baseUrl,
      streamPath: opts.streamPath,
      async [Symbol.asyncDispose]() {
        await dispose();
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function toWssAgentWebsocketUrl(httpsBase: string, instanceName: string) {
  const base = new URL(httpsBase);
  base.protocol = "wss:";
  base.pathname = `/agents/iterate-agent/${instanceName}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function stripInheritedAppConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) continue;
    if (value != null) next[key] = value;
  }

  return next;
}
