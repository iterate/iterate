import { Daytona, type Sandbox } from "@daytonaio/sdk";
import type {
  CreateSandboxOptions,
  SandboxHandle,
  SandboxProvider,
  WaitHealthyResponse,
} from "./types.ts";

type DaytonaProviderConfig = {
  snapshotName: string;
};

type DaytonaExecResult = {
  result?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

class DaytonaSandboxHandle implements SandboxHandle {
  public readonly id: string;

  public constructor(
    private sandbox: Sandbox,
    private daytona: Daytona,
  ) {
    this.id = sandbox.id;
  }

  public async exec(cmd: string[]): Promise<string> {
    const command = cmd.map(shellEscape).join(" ");
    const result = (await this.sandbox.process.executeCommand(command)) as DaytonaExecResult;
    const output = result.result ?? result.stdout ?? result.stderr ?? "";
    if (typeof result.exitCode === "number" && result.exitCode !== 0) {
      throw new Error(`Command failed (${result.exitCode}): ${command}\n${output}`);
    }
    return output;
  }

  public getUrl(opts: { port: number }): string {
    // Daytona sandboxes are created with public: true, so we use the standard preview URL format
    return `https://${opts.port}-${this.id}.dtn-us.net`;
  }

  public async waitForServiceHealthy(opts: {
    process: string;
    timeoutMs?: number;
  }): Promise<WaitHealthyResponse> {
    const { process, timeoutMs = 180_000 } = opts;
    const start = Date.now();
    const payload = JSON.stringify({
      json: { target: process, timeoutMs, includeLogs: true, logTailLines: 200 },
    });

    try {
      const result = await this.exec([
        "curl",
        "-sf",
        "http://localhost:9876/rpc/processes/waitForRunning",
        "-H",
        "Content-Type: application/json",
        "-d",
        payload,
      ]);
      const parsed = JSON.parse(result) as {
        json?: { name: string; state: string; elapsedMs: number; logs?: string };
      };
      const response = (parsed.json ?? parsed) as {
        name: string;
        state: string;
        elapsedMs: number;
        logs?: string;
      };

      if (response.state === "running") {
        return {
          healthy: true,
          state: response.state,
          elapsedMs: response.elapsedMs,
          logs: response.logs,
        };
      }
      if (response.state === "stopped" || response.state === "max-restarts-reached") {
        throw new Error(
          `Service ${process} in terminal state: ${response.state}\n\nLogs:\n${response.logs ?? "(no logs)"}`,
        );
      }
      return {
        healthy: false,
        state: response.state,
        elapsedMs: response.elapsedMs,
        error: `process state: ${response.state}`,
        logs: response.logs,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes("terminal state")) throw err;
      return {
        healthy: false,
        state: "error",
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : "unknown error",
      };
    }
  }

  public async stop(): Promise<void> {
    const sandbox = await this.daytona.get(this.id);
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
  }

  public async restart(): Promise<void> {
    const sandbox = await this.daytona.get(this.id);
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
    await sandbox.start();
  }

  public async delete(): Promise<void> {
    const sandbox = await this.daytona.get(this.id);
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
    await sandbox.delete();
  }
}

function shellEscape(value: string): string {
  if (value === "") return "''";
  if (/^[a-zA-Z0-9_/:=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createDaytonaProvider(config: DaytonaProviderConfig): SandboxProvider {
  return {
    name: "daytona",

    async createSandbox(opts?: CreateSandboxOptions): Promise<SandboxHandle> {
      const daytona = new Daytona({
        apiKey: process.env.DAYTONA_API_KEY,
        organizationId: process.env.DAYTONA_ORGANIZATION_ID,
        apiUrl: process.env.DAYTONA_API_URL,
        target: process.env.DAYTONA_TARGET,
      });

      const sandbox = await daytona.create({
        name: `sandbox-test-${Date.now()}`,
        snapshot: config.snapshotName,
        envVars: opts?.env,
        public: true,
        autoStopInterval: 0,
        autoDeleteInterval: 60,
      });

      await sandbox.start(300);

      return new DaytonaSandboxHandle(sandbox, daytona);
    },
  };
}
