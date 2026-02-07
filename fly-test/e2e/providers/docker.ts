import { join } from "node:path";
import { runCommand, sleep, urlEncodedForm } from "../run-observability-lib.ts";
import type { FetchPayload, ObservabilityProvider, ProviderInit } from "./types.ts";

function dockerCompose(
  composeFile: string,
  project: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
) {
  return runCommand("docker", ["compose", "-f", composeFile, "-p", project, ...args], options);
}

export class DockerProvider implements ObservabilityProvider {
  readonly name = "docker" as const;

  private readonly composeFile: string;
  private readonly project: string;
  private readonly cleanupOnExit: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;

  constructor(init: ProviderInit) {
    this.composeFile = join(init.flyDir, "docker-compose.local.yml");
    this.project = init.app;
    this.cleanupOnExit = init.cleanupOnExit;
    this.env = {
      ...process.env,
      TARGET_URL: init.targetUrl,
    };
    this.log = init.log;
  }

  async up(): Promise<void> {
    this.log(`Starting docker provider: project=${this.project}`);
    dockerCompose(this.composeFile, this.project, ["up", "-d", "--build"], { env: this.env });

    for (let attempt = 1; attempt <= 90; attempt += 1) {
      const sandbox = dockerCompose(
        this.composeFile,
        this.project,
        [
          "exec",
          "-T",
          "sandbox-ui",
          "curl",
          "-fsS",
          "--max-time",
          "2",
          "http://127.0.0.1:8080/healthz",
        ],
        { env: this.env, allowFailure: true },
      );
      const egressViewer = dockerCompose(
        this.composeFile,
        this.project,
        [
          "exec",
          "-T",
          "egress-proxy",
          "curl",
          "-fsS",
          "--max-time",
          "2",
          "http://127.0.0.1:18081/healthz",
        ],
        { env: this.env, allowFailure: true },
      );
      const egressMitm = dockerCompose(
        this.composeFile,
        this.project,
        [
          "exec",
          "-T",
          "egress-proxy",
          "curl",
          "-fsS",
          "--max-time",
          "2",
          "--noproxy",
          "",
          "--proxy",
          "http://127.0.0.1:18080",
          "http://127.0.0.1:18081/healthz",
        ],
        { env: this.env, allowFailure: true },
      );

      if (sandbox.status === 0 && egressViewer.status === 0 && egressMitm.status === 0) {
        this.log("Docker services are healthy");
        return;
      }
      await sleep(1000);
    }

    throw new Error("docker services did not become healthy in time");
  }

  async sandboxFetch(payload: FetchPayload): Promise<string> {
    const method = (payload.method ?? "GET").toUpperCase();
    const body = payload.body ?? "";
    const form = urlEncodedForm({
      url: payload.url,
      method,
      body,
    });

    const result = dockerCompose(
      this.composeFile,
      this.project,
      [
        "exec",
        "-T",
        "sandbox-ui",
        "curl",
        "-sS",
        "--max-time",
        "75",
        "--data",
        form,
        "http://127.0.0.1:8080/api/fetch",
      ],
      { env: this.env },
    );

    return result.stdout;
  }

  async readSandboxLog(): Promise<string> {
    const result = dockerCompose(
      this.composeFile,
      this.project,
      ["exec", "-T", "sandbox-ui", "cat", "/tmp/sandbox-ui.log"],
      { env: this.env, allowFailure: true },
    );
    return `${result.stdout}${result.stderr}`;
  }

  async readEgressLog(): Promise<string> {
    const result = dockerCompose(
      this.composeFile,
      this.project,
      ["exec", "-T", "egress-proxy", "cat", "/tmp/egress-proxy.log"],
      { env: this.env, allowFailure: true },
    );
    return `${result.stdout}${result.stderr}`;
  }

  async down(): Promise<void> {
    if (!this.cleanupOnExit) {
      this.log(
        `Docker cleanup disabled. Manual cleanup: docker compose -f ${this.composeFile} -p ${this.project} down -v`,
      );
      return;
    }
    dockerCompose(this.composeFile, this.project, ["down", "-v"], {
      env: this.env,
      allowFailure: true,
    });
    this.log("Docker cleanup complete");
  }
}
