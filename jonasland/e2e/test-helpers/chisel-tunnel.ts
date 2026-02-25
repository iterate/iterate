import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface ChiselTunnelHandle extends AsyncDisposable {
  logs(): string;
  waitUntilConnected(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartChiselReverseTunnelParams {
  serverUrl: string;
  auth: string;
  remoteBindPort: number;
  localTargetHost?: string;
  localTargetPort: number;
  chiselBin?: string;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startChiselReverseTunnel(
  params: StartChiselReverseTunnelParams,
): Promise<ChiselTunnelHandle> {
  const chiselBin = params.chiselBin ?? process.env.JONASLAND_E2E_CHISEL_BIN ?? "chisel";
  const localTargetHost = params.localTargetHost ?? "127.0.0.1";
  const timeoutMs = params.timeoutMs ?? 30_000;

  const args = [
    "client",
    "--auth",
    params.auth,
    params.serverUrl,
    `R:${String(params.remoteBindPort)}:${localTargetHost}:${String(params.localTargetPort)}`,
  ];

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(chiselBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];

  child.stdout.on("data", (chunk) => {
    output.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    output.push(String(chunk));
  });

  let stopped = false;

  const stop = async () => {
    if (!child || stopped) return;
    stopped = true;

    if (!child.killed) {
      child.kill("SIGTERM");
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      await sleep(50);
    }

    if (!child.killed) {
      child.kill("SIGKILL");
    }
  };

  const waitUntilConnected = async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `chisel client exited early with code ${String(child.exitCode)}:\n${output.join("")}`,
        );
      }

      const logs = output.join("");
      if (/connected/i.test(logs)) {
        return;
      }

      await sleep(100);
    }

    await stop();
    throw new Error(`timed out waiting for chisel connection:\n${output.join("")}`);
  };

  return {
    logs: () => output.join(""),
    waitUntilConnected,
    stop,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}
