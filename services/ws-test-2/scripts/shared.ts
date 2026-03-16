import { setTimeout as delay } from "node:timers/promises";
import { getPort } from "get-port-please";
import { x } from "tinyexec";
import { loadEnv } from "vite";

interface RunServersOptions {
  mode: "development" | "production";
  viteCommand: "vite" | "vite preview";
}

function forceKillProcess(processHandle: {
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => void;
}) {
  if (processHandle.killed) {
    return;
  }

  if (process.platform === "win32") {
    processHandle.kill();
    return;
  }

  processHandle.kill("SIGKILL");
}

export async function runFrontendAndBackendServers(options: RunServersOptions) {
  const env = loadEnv(options.mode, process.cwd(), "");
  const frontendPort = Number(process.env.PORT || env.PORT || 3000);
  const backendPort = await getPort({
    port: Number(env.VITE_BACKEND_PORT) || 0,
  });

  console.log(`\nUsing frontend port -> ${frontendPort}`);
  console.log(`Using backend port -> ${backendPort}\n`);

  const controller = new AbortController();

  const backend = x("tsx", ["src/node.ts"], {
    signal: controller.signal,
    nodeOptions: {
      env: { ...process.env, PORT: String(backendPort) },
      stdio: "inherit",
    },
  });

  const viteArgs = options.viteCommand === "vite" ? [] : ["preview"];
  const vite = x("vite", [...viteArgs, "--host", "0.0.0.0", "--port", String(frontendPort)], {
    signal: controller.signal,
    nodeOptions: {
      env: {
        ...process.env,
        PORT: String(frontendPort),
        VITE_BACKEND_PORT: String(backendPort),
      },
      stdio: "inherit",
    },
  });

  const shutdown = async () => {
    if (controller.signal.aborted) {
      return;
    }

    console.log("\nGraceful shutdown started...");
    controller.abort();

    await delay(2_500);

    forceKillProcess(backend);
    forceKillProcess(vite);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  backend.then(shutdown, shutdown);
  vite.then(shutdown, shutdown);

  await Promise.allSettled([backend, vite]);
  process.exit(0);
}
