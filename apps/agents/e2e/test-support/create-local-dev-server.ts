import { fileURLToPath } from "node:url";
import type { StreamPath } from "@iterate-com/events-contract";
import {
  useCloudflareTunnel,
  useCloudflareTunnelLease,
  useDevServer,
} from "@iterate-com/shared/test-helpers";
import { stripInheritedAppConfig } from "./app-config-env.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

interface LocalDevServerHandle {
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
    const errors: unknown[] = [];
    for (const d of disposables.reverse()) {
      try {
        await d[Symbol.asyncDispose]();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose local agents dev server resources.");
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
    try {
      await dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "Failed to create local agents dev server and clean up partial resources.",
      );
    }
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
