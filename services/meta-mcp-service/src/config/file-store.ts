import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MetaMcpError } from "../errors.ts";
import { AuthStore, MetaMcpConfig } from "./schema.ts";

async function readJsonFile(filePath: string, initialValue: unknown) {
  await mkdir(dirname(filePath), { recursive: true });

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    await writeFile(filePath, `${JSON.stringify(initialValue, null, 2)}\n`, "utf8");
    return initialValue;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export class MetaMcpFileStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly configPath: string,
    readonly authPath: string,
  ) {}

  async loadConfig(): Promise<MetaMcpConfig> {
    return this.parseConfig(await readJsonFile(this.configPath, { servers: [] }));
  }

  async loadAuthStore() {
    return this.parseAuthStore(await readJsonFile(this.authPath, { oauth: {} }));
  }

  async saveConfig(config: MetaMcpConfig): Promise<void> {
    await this.enqueueWrite(async () => {
      await writeJsonFile(this.configPath, config);
    });
  }

  async saveAuthStore(authStore: AuthStore): Promise<void> {
    await this.enqueueWrite(async () => {
      await writeJsonFile(this.authPath, authStore);
    });
  }

  async updateConfig(
    updater: (config: MetaMcpConfig) => MetaMcpConfig | Promise<MetaMcpConfig>,
  ): Promise<MetaMcpConfig> {
    return await this.enqueueWrite(async () => {
      const current = this.parseConfig(await readJsonFile(this.configPath, { servers: [] }));
      const next = await updater(current);
      await writeJsonFile(this.configPath, next);
      return next;
    });
  }

  private parseConfig(value: unknown): MetaMcpConfig {
    const parsed = MetaMcpConfig.safeParse(value);
    if (!parsed.success) {
      throw new MetaMcpError("INVALID_CONFIG", "Invalid meta MCP config.json", {
        filePath: this.configPath,
        issues: parsed.error.issues,
      });
    }

    return parsed.data;
  }

  private parseAuthStore(value: unknown): AuthStore {
    const parsed = AuthStore.safeParse(value);
    if (!parsed.success) {
      throw new MetaMcpError("INVALID_CONFIG", "Invalid meta MCP auth.json", {
        filePath: this.authPath,
        issues: parsed.error.issues,
      });
    }

    return parsed.data;
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
