export interface WaitHealthyResponse {
  healthy: boolean;
  state: string;
  elapsedMs: number;
  error?: string;
  /** Process logs (tail) - available when using pidnap's waitForRunning endpoint */
  logs?: string;
}

export interface SandboxHandle {
  id: string;
  exec(cmd: string[]): Promise<string>;
  getUrl(opts: { port: number }): string;
  waitForServiceHealthy(opts: {
    process: string;
    timeoutMs?: number;
  }): Promise<WaitHealthyResponse>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  delete(): Promise<void>;
}

export interface CreateSandboxOptions {
  env?: Record<string, string>;
  /**
   * Override the container command. When provided, entry.sh execs this command
   * directly instead of starting pidnap (see apps/os/sandbox/entry.sh).
   *
   * Example: `["sleep", "infinity"]` for a minimal container without process supervision.
   *
   * Note: This is only supported by the local-docker provider. Daytona SDK does not
   * support entrypoint/command override - sandboxes use the snapshot's baked-in entrypoint.
   */
  command?: string[];
}

export interface SandboxProvider {
  name: "local-docker" | "daytona";
  createSandbox(opts?: CreateSandboxOptions): Promise<SandboxHandle>;
}
