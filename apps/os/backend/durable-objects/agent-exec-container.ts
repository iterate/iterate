import { Container } from "@cloudflare/containers";
import type { CloudflareEnv } from "../../env.ts";

export class AgentExecContainer extends Container {
  declare env: CloudflareEnv;

  defaultPort = 3000;
  sleepAfter = "5m";

  async exec(input: {
    githubRepoUrl: string;
    githubToken: string;
    checkoutTarget: string;
    isCommitHash: boolean;
    connectedRepoPath?: string;
    ingestUrl: string;
    estateId: string;
    processId: string;
    command: string;
    env?: Record<string, string>;
    files?: Array<{ path: string; content: string }>;
  }) {
    await this.startAndWaitForPorts({
      startOptions: {
        enableInternet: true,
      },
      ports: [3000],
    });

    const response = await this.containerFetch(
      new Request("http://localhost:3000/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
      3000,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to start exec: ${response.statusText} ${text}`);
    }

    return response.json() as Promise<{ ok: true; processId: string }>;
  }

  async mkdir(dirPath: string, options?: { recursive?: boolean }) {
    await this.startAndWaitForPorts({
      startOptions: {
        enableInternet: true,
      },
      ports: [3000],
    });

    const response = await this.containerFetch(
      new Request("http://localhost:3000/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dirPath, recursive: options?.recursive ?? true }),
      }),
      3000,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to mkdir: ${response.statusText} ${text}`);
    }

    return response.json() as Promise<{ ok: true }>;
  }

  async readFile(filePath: string) {
    await this.startAndWaitForPorts({
      startOptions: {
        enableInternet: true,
      },
      ports: [3000],
    });

    const url = new URL("http://localhost:3000/read-file");
    url.searchParams.set("path", filePath);

    const response = await this.containerFetch(new Request(url.toString()), 3000);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to read file: ${response.statusText} ${text}`);
    }

    return response.json() as Promise<{
      ok: true;
      encoding: "utf-8" | "base64";
      content: string;
      mimeType: string;
    }>;
  }

  async getContainerState() {
    return {
      status: this.ctx.container?.running ? "running" : "stopped",
    };
  }
}
