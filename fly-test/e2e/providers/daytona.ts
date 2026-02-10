import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, sleep, urlEncodedForm } from "../run-observability-lib.ts";
import type { FetchPayload, ObservabilityProvider, ProviderInit } from "./types.ts";

type DaytonaInfo = {
  id: string;
  name: string;
  state?: string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function toWsUrl(raw: string): string {
  const url = new URL(raw);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseInfo(raw: string): DaytonaInfo {
  return JSON.parse(raw) as DaytonaInfo;
}

export class DaytonaProvider implements ObservabilityProvider {
  readonly name = "daytona" as const;

  private readonly flyDir: string;
  private readonly app: string;
  private readonly cleanupOnExit: boolean;
  private readonly targetUrl: string;
  private readonly log: (line: string) => void;
  private readonly target: string;
  private readonly snapshot: string;
  private readonly previewExpiresSeconds: number;
  private readonly remoteRoot = "/home/daytona/proof";
  private readonly sandboxPort: number;
  private readonly egressViewerPort: number;
  private readonly egressMitmPort: number;
  private readonly wsUpstreamUrl: string;
  private readonly tailscaleAuthKey: string;
  private readonly egressSandboxName: string;
  private readonly sandboxSandboxName: string;

  private egressSandboxId = "";
  private sandboxSandboxId = "";

  constructor(init: ProviderInit) {
    this.flyDir = init.flyDir;
    this.app = init.app;
    this.cleanupOnExit = init.cleanupOnExit;
    this.targetUrl = init.targetUrl;
    this.log = init.log;
    this.target = process.env["DAYTONA_TARGET"] ?? "eu";
    this.snapshot = process.env["DAYTONA_SNAPSHOT"] ?? "daytona-small";
    this.previewExpiresSeconds = Number(process.env["DAYTONA_PREVIEW_EXPIRES_SECONDS"] ?? "86400");
    this.sandboxPort = Number(process.env["DAYTONA_E2E_SANDBOX_PORT"] ?? "8080");
    this.egressViewerPort = Number(process.env["DAYTONA_E2E_EGRESS_VIEWER_PORT"] ?? "8081");
    this.egressMitmPort = Number(process.env["DAYTONA_E2E_EGRESS_MITM_PORT"] ?? "18080");
    this.wsUpstreamUrl = process.env["DAYTONA_WS_UPSTREAM_URL"] ?? "wss://ws.ifelse.io";
    this.tailscaleAuthKey = process.env["DAYTONA_TAILSCALE_AUTH_KEY"] ?? "";
    const base = slugify(this.app).slice(0, 44) || "fly-test";
    this.egressSandboxName = `${base}-egress`;
    this.sandboxSandboxName = `${base}-sandbox`;
  }

  private daytona(
    args: string[],
    options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
  ): { status: number; stdout: string; stderr: string } {
    return runCommand("daytona", args, options);
  }

  private execInSandbox(
    sandbox: string,
    command: string,
    options: { allowFailure?: boolean; timeoutSeconds?: number } = {},
  ): { status: number; stdout: string; stderr: string } {
    const args = ["exec", sandbox];
    if (options.timeoutSeconds !== undefined) {
      args.push("--timeout", String(options.timeoutSeconds));
    }
    args.push("--", command);
    const result = this.daytona(args, { allowFailure: true });
    if (!options.allowFailure && result.status !== 0) {
      throw new Error(
        [
          `daytona exec failed: sandbox=${sandbox}`,
          `command=${command}`,
          `status=${result.status}`,
          result.stdout.length > 0 ? `stdout:\n${result.stdout}` : "",
          result.stderr.length > 0 ? `stderr:\n${result.stderr}` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
    }
    return result;
  }

  private getInfo(name: string): DaytonaInfo {
    const info = this.daytona(["info", name, "-f", "json"]);
    return parseInfo(info.stdout);
  }

  private async waitForState(name: string, desired: string): Promise<void> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const info = this.getInfo(name);
      if (info.state === desired) return;
      await sleep(1000);
    }
    throw new Error(`daytona sandbox did not reach state=${desired}: ${name}`);
  }

  private async waitForHealth(sandbox: string, command: string): Promise<void> {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const result = this.execInSandbox(sandbox, command, { allowFailure: true });
      if (result.status === 0) return;
      await sleep(1000);
    }
    throw new Error(`health check failed: sandbox=${sandbox} command=${command}`);
  }

  private uploadBytes(sandbox: string, destinationPath: string, bytes: Buffer): void {
    const payload = bytes.toString("base64");
    const maxChunkLength = 48_000;
    if (payload.length <= maxChunkLength) {
      const script = [
        "import base64, pathlib",
        `path = pathlib.Path(${JSON.stringify(destinationPath)})`,
        "path.parent.mkdir(parents=True, exist_ok=True)",
        `path.write_bytes(base64.b64decode(${JSON.stringify(payload)}))`,
      ].join("; ");
      this.execInSandbox(sandbox, `python3 -c ${shellQuote(script)}`);
      return;
    }

    this.execInSandbox(
      sandbox,
      `python3 -c ${shellQuote(
        [
          "import pathlib",
          `path = pathlib.Path(${JSON.stringify(destinationPath)})`,
          "path.parent.mkdir(parents=True, exist_ok=True)",
          "path.write_bytes(b'')",
        ].join("; "),
      )}`,
    );

    for (let index = 0; index < payload.length; index += maxChunkLength) {
      const chunk = payload.slice(index, index + maxChunkLength);
      const appendScript = [
        "import base64, pathlib",
        `path = pathlib.Path(${JSON.stringify(destinationPath)})`,
        `path.open('ab').write(base64.b64decode(${JSON.stringify(chunk)}))`,
      ].join("; ");
      this.execInSandbox(sandbox, `python3 -c ${shellQuote(appendScript)}`);
    }
  }

  private uploadFile(sandbox: string, localPath: string, destinationPath: string): void {
    this.uploadBytes(sandbox, destinationPath, readFileSync(localPath));
  }

  private buildMitmBinary(): string {
    const cacheDir = join(this.flyDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const output = join(cacheDir, "fly-mitm-linux-amd64");
    runCommand(
      "go",
      [
        "-C",
        join(this.flyDir, "mitm-go", "go-mitm"),
        "build",
        "-trimpath",
        "-ldflags",
        "-s -w",
        "-o",
        output,
        "./",
      ],
      {
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOOS: "linux",
          GOARCH: "amd64",
        },
      },
    );
    return output;
  }

  private async connectSandboxToTailnet(sandbox: string, hostLabel: string): Promise<string> {
    if (this.tailscaleAuthKey.length === 0) {
      throw new Error("DAYTONA_TAILSCALE_AUTH_KEY is required for tailscale mode");
    }
    this.execInSandbox(
      sandbox,
      `sh -lc ${shellQuote(
        [
          "set -euo pipefail",
          "if ! command -v tailscale >/dev/null 2>&1; then",
          "  curl -fsSL https://tailscale.com/install.sh | sh >/tmp/tailscale-install.log 2>&1",
          "fi",
          "if ! pgrep -x tailscaled >/dev/null 2>&1; then",
          "  sudo nohup tailscaled >/tmp/tailscaled.log 2>&1 </dev/null &",
          "  sleep 2",
          "fi",
          `sudo tailscale up --reset --accept-dns=false --auth-key=${shellQuote(this.tailscaleAuthKey)} --hostname=${shellQuote(hostLabel)}`,
        ].join("\n"),
      )}`,
      { timeoutSeconds: 240 },
    );
    const ipResult = this.execInSandbox(sandbox, 'sh -lc "tailscale ip -4 | head -n1"');
    const ip = ipResult.stdout.trim();
    if (ip.length === 0) throw new Error(`failed to resolve tailscale ip for sandbox=${sandbox}`);
    return ip;
  }

  private createSandbox(name: string): DaytonaInfo {
    this.daytona(["delete", name], { allowFailure: true });
    this.daytona([
      "create",
      "--name",
      name,
      "--snapshot",
      this.snapshot,
      "--public",
      "--target",
      this.target,
      "--auto-stop",
      "0",
      "--auto-delete",
      "-1",
    ]);
    return this.getInfo(name);
  }

  private previewUrl(name: string, port: number): string {
    const result = this.daytona([
      "preview-url",
      name,
      "--port",
      String(port),
      "--expires",
      String(this.previewExpiresSeconds),
    ]);
    return result.stdout.trim();
  }

  async up(): Promise<void> {
    this.daytona(["version"]);
    if (process.env["DAYTONA_API_KEY"]) {
      this.daytona(["login", "--api-key", process.env["DAYTONA_API_KEY"] ?? ""]);
    }

    const useTailnetMitm = this.tailscaleAuthKey.length > 0;
    this.log(
      `Starting daytona provider: target=${this.target} snapshot=${this.snapshot} mode=${useTailnetMitm ? "tailscale-mitm" : "preview-direct"}`,
    );
    this.log(`Creating daytona egress sandbox: ${this.egressSandboxName}`);
    const egress = this.createSandbox(this.egressSandboxName);
    this.egressSandboxId = egress.id;
    await this.waitForState(this.egressSandboxName, "started");

    this.uploadFile(
      this.egressSandboxName,
      join(this.flyDir, "egress-proxy", "start.sh"),
      `${this.remoteRoot}/egress-proxy/start.sh`,
    );
    this.uploadFile(
      this.egressSandboxName,
      join(this.flyDir, "egress-proxy", "server.ts"),
      `${this.remoteRoot}/egress-proxy/server.ts`,
    );
    this.uploadFile(
      this.egressSandboxName,
      join(this.flyDir, "egress-proxy", "routes.ts"),
      `${this.remoteRoot}/egress-proxy/routes.ts`,
    );
    this.uploadFile(
      this.egressSandboxName,
      join(this.flyDir, "egress-proxy", "utils.ts"),
      `${this.remoteRoot}/egress-proxy/utils.ts`,
    );
    this.uploadFile(
      this.egressSandboxName,
      join(this.flyDir, "egress-proxy", "index.html"),
      `${this.remoteRoot}/egress-proxy/index.html`,
    );
    if (useTailnetMitm) {
      const mitmBinary = this.buildMitmBinary();
      this.uploadFile(
        this.egressSandboxName,
        join(this.flyDir, "mitm-go", "start.sh"),
        `${this.remoteRoot}/mitm-go/start.sh`,
      );
      this.uploadBytes(
        this.egressSandboxName,
        `${this.remoteRoot}/bin/fly-mitm`,
        readFileSync(mitmBinary),
      );
    }
    this.execInSandbox(
      this.egressSandboxName,
      useTailnetMitm
        ? `chmod +x ${this.remoteRoot}/egress-proxy/start.sh ${this.remoteRoot}/mitm-go/start.sh ${this.remoteRoot}/bin/fly-mitm`
        : `chmod +x ${this.remoteRoot}/egress-proxy/start.sh`,
    );
    this.execInSandbox(
      this.egressSandboxName,
      `sh -lc ${shellQuote(
        [
          `PROOF_ROOT=${shellQuote(this.remoteRoot)}`,
          "PROXIFY_CONFIG_DIR=/tmp/proxify",
          `EGRESS_ENABLE_MITM=${useTailnetMitm ? "1" : "0"}`,
          `EGRESS_MITM_PORT=${shellQuote(String(this.egressMitmPort))}`,
          `EGRESS_VIEWER_PORT=${shellQuote(String(this.egressViewerPort))}`,
          `FLY_MITM_BIN=${shellQuote(`${this.remoteRoot}/bin/fly-mitm`)}`,
          `nohup bash ${shellQuote(`${this.remoteRoot}/egress-proxy/start.sh`)} >/tmp/egress-start.log 2>&1 </dev/null &`,
        ].join(" "),
      )}`,
    );

    await this.waitForHealth(
      this.egressSandboxName,
      `curl -fsS --max-time 2 http://127.0.0.1:${this.egressViewerPort}/healthz`,
    );
    if (useTailnetMitm) {
      await this.waitForHealth(
        this.egressSandboxName,
        `curl -fsS --max-time 2 --noproxy '' --proxy http://127.0.0.1:${this.egressMitmPort} http://127.0.0.1:${this.egressViewerPort}/healthz`,
      );
    }
    const egressViewerPreviewUrl = this.previewUrl(this.egressSandboxName, this.egressViewerPort);

    this.log(`Creating daytona sandbox-ui sandbox: ${this.sandboxSandboxName}`);
    const sandbox = this.createSandbox(this.sandboxSandboxName);
    this.sandboxSandboxId = sandbox.id;
    await this.waitForState(this.sandboxSandboxName, "started");

    this.uploadFile(
      this.sandboxSandboxName,
      join(this.flyDir, "sandbox", "start.sh"),
      `${this.remoteRoot}/sandbox/start.sh`,
    );
    this.uploadFile(
      this.sandboxSandboxName,
      join(this.flyDir, "sandbox", "server.ts"),
      `${this.remoteRoot}/sandbox/server.ts`,
    );
    this.uploadFile(
      this.sandboxSandboxName,
      join(this.flyDir, "sandbox", "index.html"),
      `${this.remoteRoot}/sandbox/index.html`,
    );
    this.execInSandbox(this.sandboxSandboxName, `chmod +x ${this.remoteRoot}/sandbox/start.sh`);

    let wsProxyUrl = "";
    let egressHttpProxyUrl = "";
    let egressProxyHost = "";
    if (useTailnetMitm) {
      this.log("Connecting sandboxes to tailscale tailnet");
      const egressIp = await this.connectSandboxToTailnet(
        this.egressSandboxName,
        `${this.egressSandboxName}-eg`,
      );
      await this.connectSandboxToTailnet(this.sandboxSandboxName, `${this.sandboxSandboxName}-sb`);
      this.log(`Tailnet ready: egress_ip=${egressIp}`);
      egressProxyHost = egressIp;
      wsProxyUrl = `ws://${egressIp}:${this.egressViewerPort}/api/ws/proxy`;
    } else {
      const egressViewerPreviewUrlNoSlash = egressViewerPreviewUrl.replace(/\/$/, "");
      wsProxyUrl = `${toWsUrl(egressViewerPreviewUrlNoSlash)}/api/ws/proxy`;
      egressHttpProxyUrl = `${egressViewerPreviewUrlNoSlash}/proxy`;
    }
    this.execInSandbox(
      this.sandboxSandboxName,
      `sh -lc ${shellQuote(
        [
          `PROOF_ROOT=${shellQuote(this.remoteRoot)}`,
          `SANDBOX_PORT=${shellQuote(String(this.sandboxPort))}`,
          `SKIP_PROXY_BOOTSTRAP=${useTailnetMitm ? "0" : "1"}`,
          `EGRESS_PROXY_HOST=${shellQuote(egressProxyHost)}`,
          `EGRESS_MITM_PORT=${shellQuote(String(this.egressMitmPort))}`,
          `EGRESS_HTTP_PROXY_URL=${shellQuote(egressHttpProxyUrl)}`,
          `DEFAULT_TARGET_URL=${shellQuote(this.targetUrl)}`,
          `WS_PROXY_URL=${shellQuote(wsProxyUrl)}`,
          `WS_UPSTREAM_URL=${shellQuote(this.wsUpstreamUrl)}`,
          `nohup bash ${shellQuote(`${this.remoteRoot}/sandbox/start.sh`)} >/tmp/sandbox-start.log 2>&1 </dev/null &`,
        ].join(" "),
      )}`,
    );

    await this.waitForHealth(
      this.sandboxSandboxName,
      `curl -fsS --max-time 2 http://127.0.0.1:${this.sandboxPort}/healthz`,
    );

    const sandboxPreviewUrl = this.previewUrl(this.sandboxSandboxName, this.sandboxPort);
    this.log(`Daytona sandbox UI: ${sandboxPreviewUrl}`);
    this.log(`Daytona egress UI: ${egressViewerPreviewUrl}`);
  }

  async sandboxFetch(payload: FetchPayload): Promise<string> {
    const method = (payload.method ?? "GET").toUpperCase();
    const body = payload.body ?? "";
    const form = urlEncodedForm({
      url: payload.url,
      method,
      body,
    });
    const command = `curl -sS --max-time 75 --data '${form}' http://127.0.0.1:${this.sandboxPort}/api/fetch`;
    const result = this.execInSandbox(this.sandboxSandboxName, command);
    return result.stdout;
  }

  async readSandboxLog(): Promise<string> {
    const result = this.execInSandbox(this.sandboxSandboxName, "cat /tmp/sandbox-ui.log", {
      allowFailure: true,
    });
    return `${result.stdout}${result.stderr}`;
  }

  async readEgressLog(): Promise<string> {
    const result = this.execInSandbox(this.egressSandboxName, "cat /tmp/egress-proxy.log", {
      allowFailure: true,
    });
    return `${result.stdout}${result.stderr}`;
  }

  async down(): Promise<void> {
    if (!this.cleanupOnExit) {
      this.log(
        `Daytona cleanup disabled. Manual cleanup: daytona delete ${this.egressSandboxName} && daytona delete ${this.sandboxSandboxName}`,
      );
      return;
    }

    if (this.sandboxSandboxId.length > 0) {
      this.daytona(["delete", this.sandboxSandboxId], { allowFailure: true });
    }
    if (this.egressSandboxId.length > 0) {
      this.daytona(["delete", this.egressSandboxId], { allowFailure: true });
    }
    this.log("Daytona cleanup complete");
  }
}
