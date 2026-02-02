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

  public getHostPort(_containerPort: number): number {
    throw new Error("getHostPort not supported for Daytona sandboxes");
  }

  public async waitForServiceHealthy(
    service: string,
    timeoutMs = 180_000,
  ): Promise<WaitHealthyResponse> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const remainingMs = timeoutMs - (Date.now() - start);
        const payload = JSON.stringify({
          json: {
            service,
            timeoutMs: Math.min(30_000, remainingMs),
          },
        });
        const result = await this.exec([
          "curl",
          "-sf",
          "http://localhost:9876/rpc/services/waitHealthy",
          "-H",
          "Content-Type: application/json",
          "-d",
          payload,
        ]);
        const parsed = JSON.parse(result) as { json?: WaitHealthyResponse };
        const response = parsed.json ?? parsed;
        if (response.healthy) return response;
        if (response.error === "terminal_state") {
          throw new Error(`Service ${service} in terminal state: ${response.state}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("terminal state")) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timeout waiting for service ${service}`);
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
