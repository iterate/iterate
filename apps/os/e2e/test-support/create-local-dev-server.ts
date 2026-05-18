import { fileURLToPath } from "node:url";
import {
  getFreePort,
  useCloudflareTunnel,
  useCloudflareTunnelLease,
  useDevServer,
} from "@iterate-com/shared/test-helpers";
import { stripInheritedAppConfig } from "./app-config-env.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

interface LocalDevServerHandle {
  baseUrl: string;
  publicUrl: string;
}

export async function createLocalDevServer(opts: {
  extraEnv?: Record<string, string>;
  healthcheckPath?: string;
  publicTunnel?: boolean;
}): Promise<LocalDevServerHandle & AsyncDisposable> {
  const disposables: AsyncDisposable[] = [];
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (const disposable of disposables.reverse()) {
      try {
        await disposable[Symbol.asyncDispose]();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose local os dev server resources.");
    }
  };

  try {
    const tunnelLease = opts.publicTunnel ? await useCloudflareTunnelLease({}) : null;
    if (tunnelLease) disposables.push(tunnelLease);

    const env: Record<string, string> = {
      ...stripInheritedAppConfig(process.env),
      ...opts.extraEnv,
    };

    const devServer = await useDevServer({
      cwd: appRoot,
      command: "pnpm",
      args: ["exec", "tsx", "./alchemy.run.ts"],
      port: tunnelLease?.localPort ?? (await getFreePort()),
      env,
      inheritEnv: false,
      healthcheckPath: opts.healthcheckPath ?? "/",
      timeoutMs: 60_000,
    });
    disposables.push(devServer);
    console.info(`[e2e] OS dev server: ${devServer.baseUrl}`);

    if (!tunnelLease) {
      return {
        baseUrl: devServer.baseUrl,
        publicUrl: devServer.baseUrl,
        async [Symbol.asyncDispose]() {
          await dispose();
        },
      };
    }

    const tunnel = await useCloudflareTunnel({
      token: tunnelLease.tunnelToken,
      publicUrl: tunnelLease.publicUrl,
    });
    disposables.push(tunnel);

    return {
      baseUrl: devServer.baseUrl,
      publicUrl: tunnel.publicUrl,
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
        "Failed to create local os dev server and clean up partial resources.",
      );
    }
    throw error;
  }
}
