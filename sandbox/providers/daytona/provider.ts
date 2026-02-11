/**
 * Daytona Provider Implementation
 *
 * Creates and manages sandbox containers via Daytona SDK.
 */

import { Daytona, type Sandbox as DaytonaSDKSandbox } from "@daytonaio/sdk";
import { z } from "zod/v4";
import { resolveDaytonaSandboxByIdentifier } from "./resolve-sandbox.ts";
import {
  Sandbox,
  SandboxProvider,
  type ProviderState,
  type CreateSandboxOptions,
  type SandboxInfo,
  type SnapshotInfo,
} from "../types.ts";

/**
 * Zod schema for Daytona provider environment variables.
 */
const DaytonaEnv = z.object({
  DAYTONA_API_KEY: z.string(),
  DAYTONA_ORG_ID: z.string().optional(),
  DAYTONA_DEFAULT_SNAPSHOT: z.string().optional(),
  DAYTONA_DEFAULT_AUTO_STOP_MINUTES: z.string().optional(),
  DAYTONA_DEFAULT_AUTO_DELETE_MINUTES: z.string().optional(),
  APP_STAGE: z.string().optional(),
  DOPPLER_CONFIG: z.string().optional(),
});

type DaytonaEnv = z.infer<typeof DaytonaEnv>;
const DAYTONA_CREATE_TIMEOUT_SECONDS = 180;

/**
 * Daytona sandbox implementation.
 * Extends the abstract Sandbox class with Daytona-specific functionality.
 */
export class DaytonaSandbox extends Sandbox {
  readonly providerId: string;
  readonly type = "daytona" as const;
  readonly runtimeSandboxId: string | undefined;

  private readonly daytona: Daytona;
  private resolvedSandboxId: string | null = null;

  constructor(daytona: Daytona, externalId: string, sandboxId?: string) {
    super();
    this.daytona = daytona;
    this.providerId = externalId;
    this.runtimeSandboxId = sandboxId;
    this.resolvedSandboxId = sandboxId ?? null;
  }

  private async resolveSandboxId(): Promise<string> {
    if (this.resolvedSandboxId) return this.resolvedSandboxId;
    const sandbox = await resolveDaytonaSandboxByIdentifier(this.daytona, this.providerId);
    if (!sandbox.id) {
      throw new Error(`Daytona sandbox resolved without id for identifier '${this.providerId}'`);
    }
    this.resolvedSandboxId = sandbox.id;
    return this.resolvedSandboxId;
  }

  async getBaseUrl(opts: { port: number }): Promise<string> {
    const sandboxId = await this.resolveSandboxId();
    return `https://${opts.port}-${sandboxId}.proxy.daytona.works`;
  }

  // === Lifecycle ===

  private async getSdkSandbox(): Promise<DaytonaSDKSandbox> {
    const sandboxId = await this.resolveSandboxId();
    return this.daytona.get(sandboxId);
  }

  async exec(cmd: string[]): Promise<string> {
    // Daytona SDK takes a command string, not an array.
    // We need to properly quote arguments that contain spaces or shell special chars.
    const quotedCmd = cmd
      .map((arg) => {
        // If arg contains spaces, quotes, or shell special chars, wrap in single quotes
        // and escape any single quotes inside
        if (/[\s"'`$\\|&;<>(){}[\]*?!~]/.test(arg)) {
          return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return arg;
      })
      .join(" ");
    const sandbox = await this.getSdkSandbox();
    const result = await sandbox.process.executeCommand(quotedCmd);
    return result.result ?? "";
  }

  async getState(): Promise<ProviderState> {
    try {
      const sandbox = await this.getSdkSandbox();
      return {
        state: sandbox.state ?? "unknown",
        errorReason: sandbox.errorReason,
      };
    } catch (err) {
      return {
        state: "error",
        errorReason: String(err),
      };
    }
  }

  async start(): Promise<void> {
    const sandbox = await this.getSdkSandbox();
    await sandbox.start();
  }

  async stop(): Promise<void> {
    const sandbox = await this.getSdkSandbox();
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
  }

  async restart(): Promise<void> {
    const sandbox = await this.getSdkSandbox();
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
    await sandbox.start();
  }

  async archive(): Promise<void> {
    const sandbox = await this.getSdkSandbox();
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
    await sandbox.archive();
  }

  async delete(): Promise<void> {
    const sandbox = await this.getSdkSandbox();
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
    await sandbox.delete();
  }
}

/**
 * Daytona provider implementation.
 * Extends the abstract SandboxProvider class.
 */
export class DaytonaProvider extends SandboxProvider {
  protected readonly envSchema = DaytonaEnv;
  declare protected readonly env: DaytonaEnv;

  readonly type = "daytona" as const;

  private readonly daytona: Daytona;

  constructor(rawEnv: Record<string, string | undefined>) {
    super(rawEnv);
    this.parseEnv(rawEnv); // Must call after super() since envSchema is a field declaration
    this.daytona = new Daytona({
      apiKey: this.env.DAYTONA_API_KEY,
      organizationId: this.env.DAYTONA_ORG_ID,
    });
  }

  get defaultSnapshotId(): string {
    if (!this.env.DAYTONA_DEFAULT_SNAPSHOT) {
      throw new Error(
        "DAYTONA_DEFAULT_SNAPSHOT is not set and no snapshot was provided. " +
          "Either set DAYTONA_DEFAULT_SNAPSHOT or pass providerSnapshotId when creating a sandbox.",
      );
    }
    return this.env.DAYTONA_DEFAULT_SNAPSHOT;
  }

  async create(opts: CreateSandboxOptions): Promise<DaytonaSandbox> {
    const sandboxName = opts.externalId;
    if (!sandboxName) {
      throw new Error("Daytona create requires externalId");
    }

    const autoStopInterval = this.env.DAYTONA_DEFAULT_AUTO_STOP_MINUTES
      ? Number(this.env.DAYTONA_DEFAULT_AUTO_STOP_MINUTES)
      : undefined;
    const autoDeleteInterval = this.env.DAYTONA_DEFAULT_AUTO_DELETE_MINUTES
      ? Number(this.env.DAYTONA_DEFAULT_AUTO_DELETE_MINUTES)
      : undefined;

    const envVars = { ...opts.envVars };
    const entrypointArguments = opts.entrypointArguments;
    if (entrypointArguments && entrypointArguments.length > 0) {
      // Providers like Daytona cannot pass container start args at sandbox creation time.
      // We tunnel entrypoint args via env var so sandbox/entry.sh can exec them.
      envVars.SANDBOX_ENTRY_ARGS = entrypointArguments.join("\t");
    }

    const snapshotId = opts.providerSnapshotId ?? this.defaultSnapshotId;
    const sdkSandbox = await this.daytona.create(
      {
        name: sandboxName,
        snapshot: snapshotId,
        envVars,
        autoStopInterval,
        autoDeleteInterval,
        public: true,
      },
      { timeout: DAYTONA_CREATE_TIMEOUT_SECONDS },
    );

    return new DaytonaSandbox(this.daytona, sandboxName, sdkSandbox.id);
  }

  get(providerId: string): DaytonaSandbox | null {
    return this.getWithSandboxId({ providerId });
  }

  getWithSandboxId(params: { providerId: string; sandboxId?: string }): DaytonaSandbox | null {
    const { providerId, sandboxId } = params;
    return new DaytonaSandbox(this.daytona, providerId, sandboxId);
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const response = await this.daytona.list();
    // The list() returns a PaginatedSandboxes, access the items array
    const sandboxes = response.items ?? [];
    return sandboxes.map((s) => ({
      type: "daytona" as const,
      providerId: s.name ?? s.id,
      name: s.name ?? s.id,
      state: s.state ?? "unknown",
    }));
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    // Daytona doesn't have a snapshots API accessible via SDK
    // Return the configured default snapshot if available
    if (!this.env.DAYTONA_DEFAULT_SNAPSHOT) return [];
    return [
      {
        type: "daytona" as const,
        snapshotId: this.env.DAYTONA_DEFAULT_SNAPSHOT,
        name: this.env.DAYTONA_DEFAULT_SNAPSHOT,
      },
    ];
  }
}
