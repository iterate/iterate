export interface WaitHealthyResponse {
  healthy: boolean;
  state: string;
  logs: string[];
  elapsedMs: number;
  error?: string;
}

export interface SandboxHandle {
  id: string;
  exec(cmd: string[]): Promise<string>;
  getHostPort(containerPort: number): number;
  waitForServiceHealthy(service: string, timeoutMs?: number): Promise<WaitHealthyResponse>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  delete(): Promise<void>;
}

export interface CreateSandboxOptions {
  env?: Record<string, string>;
}

export interface SandboxProvider {
  name: "local-docker" | "daytona";
  createSandbox(opts?: CreateSandboxOptions): Promise<SandboxHandle>;
}
