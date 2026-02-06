/**
 * Daytona Provider Implementation
 *
 * Creates and manages sandbox containers via Daytona SDK.
 */

import { Daytona, type Sandbox as DaytonaSDKSandbox } from "@daytonaio/sdk";
import { z } from "zod/v4";
import {
  Sandbox,
  SandboxProvider,
  type ProviderState,
  type CreateSandboxOptions,
  type SandboxInfo,
  type SnapshotInfo,
} from "../types.ts";
import { slugify } from "../utils.ts";

/**
 * Zod schema for Daytona provider environment variables.
 */
const DaytonaEnv = z.object({
  DAYTONA_API_KEY: z.string(),
  DAYTONA_ORG_ID: z.string().optional(),
  DAYTONA_SNAPSHOT_NAME: z.string(),
  DAYTONA_SANDBOX_AUTO_STOP_INTERVAL: z.string().optional(),
  DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL: z.string().optional(),
  APP_STAGE: z.string().optional(),
  DOPPLER_CONFIG: z.string().optional(),
});

type DaytonaEnv = z.infer<typeof DaytonaEnv>;

/**
 * Daytona sandbox implementation.
 * Extends the abstract Sandbox class with Daytona-specific functionality.
 */
export class DaytonaSandbox extends Sandbox {
  readonly providerId: string;
  readonly type = "daytona" as const;

  private readonly daytona: Daytona;

  constructor(daytona: Daytona, sandboxId: string) {
    super();
    this.daytona = daytona;
    this.providerId = sandboxId;
  }

  // === Core abstraction ===

  async getFetch(opts: { port: number }): Promise<typeof fetch> {
    const baseUrl = await this.getPreviewUrl(opts);
    return (input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? `${baseUrl}${input}` : input;
      return fetch(url, init);
    };
  }

  async getPreviewUrl(opts: { port: number }): Promise<string> {
    return `https://${opts.port}-${this.providerId}.proxy.daytona.works`;
  }

  // === Lifecycle ===

  private async getSdkSandbox(): Promise<DaytonaSDKSandbox> {
    return this.daytona.get(this.providerId);
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
    this.resetClientCaches();
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
    this.resetClientCaches();
    const sandbox = await this.getSdkSandbox();
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
    await sandbox.start();
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
    return this.env.DAYTONA_SNAPSHOT_NAME;
  }

  async create(opts: CreateSandboxOptions): Promise<DaytonaSandbox> {
    // Build sandbox name from config and options
    const configSlug = slugify(this.env.DOPPLER_CONFIG ?? this.env.APP_STAGE ?? "unknown").slice(
      0,
      20,
    );
    const projectSlug = slugify(opts.envVars["ITERATE_PROJECT_SLUG"] ?? "project").slice(0, 15);
    const machineSlug = slugify(opts.id ?? opts.name).slice(0, 15);
    // Add random suffix to avoid name collisions in concurrent test runs
    const randomSuffix = Math.random().toString(36).slice(2, 8);
    const sandboxName = `${configSlug}--${projectSlug}--${machineSlug}-${randomSuffix}`.slice(
      0,
      63,
    );

    const autoStopInterval = this.env.DAYTONA_SANDBOX_AUTO_STOP_INTERVAL
      ? Number(this.env.DAYTONA_SANDBOX_AUTO_STOP_INTERVAL)
      : undefined;
    const autoDeleteInterval = this.env.DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL
      ? Number(this.env.DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL)
      : undefined;

    const snapshotId = opts.snapshotId ?? this.defaultSnapshotId;
    const sdkSandbox = await this.daytona.create({
      name: sandboxName,
      snapshot: snapshotId,
      envVars: opts.envVars,
      autoStopInterval,
      autoDeleteInterval,
      public: true,
    });

    return new DaytonaSandbox(this.daytona, sdkSandbox.id);
  }

  get(providerId: string): DaytonaSandbox | null {
    // Return a handle - operations will fail if sandbox doesn't exist
    return new DaytonaSandbox(this.daytona, providerId);
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const response = await this.daytona.list();
    // The list() returns a PaginatedSandboxes, access the items array
    const sandboxes = response.items ?? [];
    return sandboxes.map((s) => ({
      type: "daytona" as const,
      providerId: s.id,
      name: s.name ?? s.id,
      state: s.state ?? "unknown",
    }));
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    // Daytona doesn't have a snapshots API accessible via SDK
    // Return the configured snapshot as the only option
    return [
      {
        type: "daytona" as const,
        snapshotId: this.defaultSnapshotId,
        name: this.defaultSnapshotId,
      },
    ];
  }
}
