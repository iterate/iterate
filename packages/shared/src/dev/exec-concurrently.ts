import { setTimeout as delay } from "node:timers/promises";
import { x } from "tinyexec";

type ExecCommand = Parameters<typeof x>;

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

/**
 * Run long-lived commands concurrently with shared signal handling.
 *
 * The point of this helper is to keep multi-process dev flows simple:
 * start everything together, shut everything down together, and make sure
 * Ctrl+C or one crashing process tears down the rest cleanly.
 */
export async function execConcurretly(params: { commands: ExecCommand[]; killTimeoutMs?: number }) {
  const { commands, killTimeoutMs = 2500 } = params;
  const controller = new AbortController();

  const processes = commands.map(([command, args, options]) =>
    x(command, args, {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
    }),
  );

  const shutdown = async () => {
    if (controller.signal.aborted) {
      return;
    }

    console.log("\nGraceful shutdown started...");
    controller.abort();

    await delay(killTimeoutMs);

    for (const processHandle of processes) {
      forceKillProcess(processHandle);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    for (const processHandle of processes) {
      processHandle.then(shutdown, shutdown);
    }

    await Promise.allSettled(processes);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
